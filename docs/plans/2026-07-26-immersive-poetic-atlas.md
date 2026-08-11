# Immersive Poetic Atlas Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the constrained 2D/3D StarMap page with a full-viewport, semantically arranged, interactive 3D poetry universe whose displayed counts exactly match the rendered graph.

**Architecture:** Keep the existing API, normalized graph model, node detail content, Zustand filters, and React Three Fiber renderer. Add one shared universe-scene derivation module so page metrics and 3D rendering use the same filtered graph; switch `/starmap` to the immersive shell; remove the 2D entry and make the existing list the only fallback.

**Tech Stack:** React 18, TypeScript, Zustand, React Three Fiber, Drei, Three.js, CSS, Node.js audit script, Vite.

---

### Task 1: Establish graph integrity and scene truth

**Files:**
- Create: `frontend/scripts/audit-starmap.mjs`
- Create: `frontend/src/pages/StarMapPage/graphUniverse.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/src/pages/StarMapPage/graphRender.ts`

**Steps:**
1. Add an HTTP audit that checks exact poem/poet counts, duplicate IDs, duplicate edges and dangling endpoints.
2. Run the audit against `http://localhost:3001/api/knowledge-graph/full`; expect 148 poems, 63 poets, zero duplicates and zero dangling edges.
3. Add a shared `buildUniverseScene` function for type filtering, display-edge simplification, lens filtering and bounded two-hop focus.
4. Correct strong inferred-edge retention so only normalized 0–1 scores can qualify as unconditional strong edges.
5. Run `npm run lint`; expect zero TypeScript errors.

### Task 2: Switch the route to a full-viewport immersive shell

**Files:**
- Modify: `frontend/src/config/nav.ts`
- Modify: `frontend/src/pages/StarMapPage/StarMapPage.tsx`
- Modify: `frontend/src/pages/StarMapPage/StarMapPage.css`

**Steps:**
1. Return `immersive` for `/starmap` while keeping all other routes classic.
2. Remove the page-level radar section and fixed two-column layout.
3. Add a full-screen stage, floating title/data HUD, explorer trigger, relation lens and non-blocking detail panel.
4. Use shared scene data for “全库 / 当前视野 / 关系轨道” numbers.
5. Run `npm run lint`; expect zero TypeScript errors.

### Task 3: Remove 2D and rebuild the explorer as an observatory drawer

**Files:**
- Modify: `frontend/src/pages/StarMapPage/StarMapSidebar.tsx`
- Modify: `frontend/src/pages/StarMapPage/NodeDetail3DPanel.tsx`
- Modify: `frontend/src/pages/StarMapPage/NodeDetail3DPanel.css`
- Modify: `frontend/src/pages/StarMapPage/StarMapPage.tsx`

**Steps:**
1. Change canvas mode to `universe | list` and remove all 2D controls and imports.
2. Make the explorer drawer openable on every breakpoint and add an explicit close control.
3. Replace “在2D视图查看” with local-universe navigation.
4. Make 3D failures fall back to the list.
5. Verify no visible text or control exposes a 2D view.

### Task 4: Implement semantic universe layout and dynamic focus

**Files:**
- Modify: `frontend/src/pages/StarMapPage/StarMap3D.tsx`
- Modify: `frontend/src/pages/StarMapPage/StarMap3DNode.tsx`
- Modify: `frontend/src/pages/StarMapPage/StarMap3DEdges.tsx`
- Modify: `frontend/src/pages/StarMapPage/StarMap3D.css`

**Steps:**
1. Replace pseudo-3D D3 force positions with deterministic era → poet → poem orbital layout.
2. Position imagery, theme and rhetoric clouds from the centroids of their connected poems.
3. Use the shared focused scene so double-click enters a bounded two-hop universe.
4. Add subtle deterministic drift, focus camera travel, organic active relation flow and an exit-focus control.
5. Preserve reduced-motion and dynamic DPR behavior.

### Task 5: Responsive, accessibility and visual refinement

**Files:**
- Modify: `frontend/src/pages/StarMapPage/StarMapPage.css`
- Modify: `frontend/src/pages/StarMapPage/StarMap3D.css`

**Steps:**
1. Apply the lacquer-black, mineral-gold, celadon and cinnabar palette locally to the immersive route.
2. Ensure the scene fills the viewport without document scrolling.
3. Make explorer, relation lens, camera controls and node details usable at desktop, tablet and mobile widths.
4. Verify focus-visible, escape close, semantic labels and reduced-motion fallbacks.

### Task 6: Full verification

**Files:**
- Modify as required by fixes found during verification.

**Steps:**
1. Run `npm run audit:starmap`.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Open `/starmap` and verify the rendered counts match DOM-visible counters.
5. Verify explorer open/close, lens switching, node selection, detail close, local-universe enter/exit and list fallback.
6. Capture desktop and mobile screenshots; fix every visible overlap, clipping or undersized-stage issue before delivery.
