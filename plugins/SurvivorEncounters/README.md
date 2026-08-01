# Survivor Encounters

Open GPL plugin for the single-player/PvE human-NPC layer. Core server code
owns replication, inventories, weapons, combat, factions, and navigation. This
plugin owns the replaceable gameplay policy:

- which military, medic, police, survivor, or bandit profiles exist;
- their stable POI spawn slots and faction disposition;
- periodic replacement after corpses naturally despawn;
- ambient zombie-to-bandit replacement chance;
- `/encounters`, `/mission`, and `/encounter` admin controls.

The first launch creates `plugins/survivor-encounters-config.yaml`. Add a
hostile profile with `disposition: bandit` and `role: bandit` to turn a POI into
a clear mission. Spawner ID ranges must be unique across profiles and plugins.

Build independently with:

```powershell
npm install
npm run build
```

The loader rewrites the `@h1z1-server` runtime imports to the active server
checkout, keeping the plugin distributable without copying core code.
