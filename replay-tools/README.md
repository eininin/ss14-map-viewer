# Replay tools

Two console commands that run inside a fork's own client (headless), built at the exact commit
a server replay was recorded on:

- `replay_chunk <replay.zip> <outDir> [seconds=60]`: splits a replay into short replays. Each
  one starts from a full game state (the engine's own checkpoint) and plays in the normal SS14
  replay player, using only that chunk's memory. Also writes `chunks.json` (file, start/end tick,
  start/end seconds).
- `replay_export_grids <replay.zip> <seconds> <outDir> [gridNetEntity]`: jumps to any time
  (not only chunk boundaries) and saves every grid, or one, as a map `.yml`, plus `grids.json`.
  Works on full replays and on chunks.

A replay only holds networked state: exported grids have tiles, decals, prototypes, positions,
rotations and appearance, but not server-only component data.

## Running it

GitHub Actions, workflow **Replay tools** (`.github/workflows/replay-tools.yml`):
- Actions tab → Run workflow → replay URL, server, mode, seconds, or
- on a branch, edit `replay-tools/job.env` and push.

The workflow reads `buildForkVersion` from the replay's `replay.yml`, checks out that commit of
the fork (Space Wizards, Starlight or HardLight), copies `ReplayTools/*.cs` into
`Content.Client/_ReplayTools/`, builds it and runs the command with `ROBUST_DISABLE_SANDBOX=1`.
Output (chunk zips or grid ymls, plus `run.log` with peak memory) is the run's artifact.

On your own PC the same works: copy the `.cs` files into `Content.Client/_ReplayTools/` of the
fork checked out at the replay's commit, build, then run
`ROBUST_DISABLE_SANDBOX=1 bin/Content.Client/Content.Client --headless "+replay_chunk <zip> <out> 60"`.

`replay_info.py <replay.zip>` prints a replay's engine/fork/build info.
