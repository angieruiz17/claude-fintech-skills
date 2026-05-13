---
name: react-hooks-discipline
description: The five React rules that prevent 95% of runtime crashes -- hooks before early returns, defensive rendering for async data, stable list keys, useEffect cleanup, Map / Set state instances.
---

# React Hooks Discipline

The most expensive React bugs in production come from a small set of repeating patterns. This skill captures the five rules that avoid them, with the canonical symptoms, fixes, and a pre-deploy checklist.

## When to use

- Writing a new component with `useState` / `useEffect`
- Reviewing a front-end patch that touches hooks or async data
- Investigating a white screen or `TypeError` in the F12 console
- Pre-commit / pre-deploy checklist for any React change

## Rule 1: hooks must be called *before* any early return

React requires the number of hooks called on each render to be **constant**. Conditional hook calls after an `if (...) return ...` change the count between renders and trigger:

```
Error: Rendered more hooks than during the previous render
(minified: Error: Minified React error #310)
```

Symptom: white screen after a state transition (login -> authenticated, setup -> session, etc.). Stack in F12 contains `useEffect` near the bottom.

### Bad

```jsx
function App() {
  const [identity, setIdentity] = useState(null);
  const [session, setSession]   = useState(null);

  if (!identity) return <LoginScreen />;          // early return
  if (!session)  return <SessionList />;          // early return

  useEffect(() => {                                // hook AFTER early returns
    fetch(`/api/sessions/${session.id}/data`);
  }, [session.id]);

  return <TradingScreen />;
}
```

When `identity` is null, the `useEffect` is **not** called. When it becomes truthy, it suddenly **is** called -> hook count differs across renders -> crash.

### Good

```jsx
function App() {
  const [identity, setIdentity] = useState(null);
  const [session, setSession]   = useState(null);

  useEffect(() => {                                // always declared
    if (!session) return;                          // guard inside the callback
    fetch(`/api/sessions/${session.id}/data`);
  }, [session?.id]);

  if (!identity) return <LoginScreen />;
  if (!session)  return <SessionList />;

  return <TradingScreen />;
}
```

The hook is always invoked; the conditional behaviour lives **inside** the callback.

### Verify before commit

```bash
# All hooks
grep -nE "useState|useEffect|useCallback|useMemo|useRef" src/App.tsx

# First early return
grep -n "^\s*return (" src/App.tsx | head -1
```

Every hook line number must be **smaller** than the first `return (` line number.

## Rule 2: defensive rendering for async data

Data from `fetch` or WebSocket arrives asynchronously. The first render almost always sees `undefined` or `null` values.

Symptom: `TypeError: Cannot read properties of undefined (reading 'toFixed')` (or `.toString`, `.map`, `.length`).

### Two complementary fixes

Fix A: tolerant formatter (preferred, callers don't have to remember).

```ts
const formatPrice = (p: number | null | undefined): string => {
  if (p === null || p === undefined || isNaN(p)) return '-';
  return p.toFixed(2);
};
```

Fix B: guard at the call site.

```tsx
{prices?.map((p, i) => {
  if (p == null || isNaN(p)) return <Cell key={i}>-</Cell>;
  return <Cell key={i}>{p.toFixed(2)}</Cell>;
})}
```

### `??` does NOT catch `NaN`

```ts
const x = parseFloat('');       // NaN
const y = x ?? 16.21;           // still NaN -- ?? only catches null / undefined

// Correct
const y = (isNaN(x) ? undefined : x) ?? 16.21;   // 16.21
// Or, knowing 0 is acceptable here:
const y = x || 16.21;                            // 16.21 (|| catches NaN as falsy)
```

Pick the form that suits the semantics (`||` also rejects `0`, watch out).

## Rule 3: stable list keys

```tsx
// Bad when the list can be re-ordered or items inserted at the front
{items.map((item, idx) => <Row key={idx} />)}

// Good
{items.map((item) => <Row key={item.id} />)}
```

With `key={idx}`, prepending an item makes React think item 0 changed (instead of moving). Re-renders are wrong and per-row state (focus, edits, animations) leaks across items.

## Rule 4: `useEffect` cleanup is not optional

```tsx
useEffect(() => {
  const id = setInterval(() => poll(), 5_000);
  return () => clearInterval(id);     // cleanup
}, []);

useEffect(() => {
  const ws = new WebSocket(url);
  ws.onmessage = onMsg;
  return () => ws.close();            // cleanup
}, [url]);
```

Without cleanup: intervals keep firing after unmount, WebSockets keep eating bandwidth, `setState` on unmounted components -> warning or crash.

## Rule 5: `Map` and `Set` state need new instances

```tsx
const [m, setM] = useState(new Map());

// Bad -- mutates in place, React doesn't detect the change
m.set('key', 'value');
setM(m);

// Good -- new instance
const next = new Map(m);
next.set('key', 'value');
setM(next);
```

Same applies to `Set`, plain objects, and arrays when used as state. React relies on referential equality to decide whether to re-render.

## Pre-deploy checklist

- [ ] `grep useEffect src/App.tsx` -- all of them appear **before** the first `return (`
- [ ] Every `.toFixed` / `.toString` / `.map` has a null / undefined / NaN guard
- [ ] `parseFloat` results protected with `|| fallback`, not `?? fallback`
- [ ] List keys are stable (item id), not index, unless the list is truly immutable
- [ ] Every `useEffect` with timers, subscriptions, or listeners has a cleanup `return`
- [ ] Map / Set state always assigned a new instance
- [ ] `npm run build` passes with no TypeScript errors
- [ ] Smoke-tested the failing transitions: login -> auth, empty list -> populated, async loading -> render

## When this skill applies

- New React component with hooks
- Front-end patch adding or moving a hook
- User reports a white screen, especially after a state transition
- F12 console shows `TypeError` on async data
- Code review of any non-trivial React change
