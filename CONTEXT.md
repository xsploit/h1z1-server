# Domain language

- **Navigation archetype**: one hash-bound collision actor plus its reviewed
  semantic recipe and route-validation template. Repeated world placements of
  the same actor share the archetype but are validated independently.
- **Navigation crawl**: the deterministic, whole-map analysis that inventories
  unknown collision geometry, proposes review evidence, prepares known
  archetypes, and optionally schedules exact regional bakes and validations.
- **Semantic proposal**: read-only geometry evidence for human review. A
  proposal never edits the canonical semantic policy or admits an archetype.
- **Regional bake key**: the SHA-256 identity of every baker input, option, and
  exact world bound needed to reproduce a regional navmesh cache.
- **Admission**: the explicit reviewed change that promotes a semantic recipe
  and route evidence into the canonical policy. Passing a heuristic is not
  admission.

