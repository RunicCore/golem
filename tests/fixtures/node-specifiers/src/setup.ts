// No import or export: a script file, so the checker gives a side-effect import of it no module symbol.
(globalThis as { setupRan?: boolean }).setupRan = true;
