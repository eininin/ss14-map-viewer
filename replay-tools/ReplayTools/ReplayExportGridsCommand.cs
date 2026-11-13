// replay_export_grids <replay.zip|-> <seconds> <outDir|-> [gridNetEntity]
//   Loads a replay (a full one or a chunk from replay_chunk) headless, jumps to <seconds> after its start
//   (any tick, not only chunk boundaries), saves every grid (or only the given one) as a map .yml, and
//   closes the game.
//
// savegrids [outDir] [gridNetEntity]
//   For the game window: while watching a replay, pause anywhere and run this to save every grid at
//   exactly that moment. Does not close the game. Default folder: $REPLAYTOOLS_SAVE_DIR (set by the
//   desktop app's "Open in game"), otherwise "SS14 replay saves" in Documents.
//
// Note: a replay only contains networked component state, so the saved grids have layout, tiles,
// decals, prototypes, positions, rotations and appearance, but not server-only component data.

using System;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Robust.Client;
using Robust.Client.Replays.Loading;
using Robust.Client.Replays.Playback;
using Robust.Shared.Console;
using Robust.Shared.ContentPack;
using Robust.Shared.EntitySerialization.Systems;
using Robust.Shared.GameObjects;
using Robust.Shared.IoC;
using Robust.Shared.Log;
using Robust.Shared.Map.Components;
using Robust.Shared.Replays;
using Robust.Shared.Utility;

namespace Content.Client._ReplayTools;

internal static class GridSaver
{
    /// <summary>Saves every grid (or one) in the current world to outDir. Returns how many were saved.</summary>
    public static int SaveAll(ISawmill log, string outDir, int? onlyGrid, ReplayData? replay)
    {
        var entMan = IoCManager.Resolve<IEntityManager>();
        var res = IoCManager.Resolve<IResourceManager>();
        var mapLoader = entMan.System<MapLoaderSystem>();
        Directory.CreateDirectory(outDir);

        var tick = replay?.CurTick.Value ?? 0;
        var seconds = replay?.CurrentReplayTime.TotalSeconds ?? 0;
        var listing = new StringBuilder("[\n");
        var saved = 0;
        var query = entMan.EntityQueryEnumerator<MapGridComponent>();
        while (query.MoveNext(out var uid, out _))
        {
            var net = entMan.GetNetEntity(uid);
            if (onlyGrid != null && net.Id != onlyGrid.Value)
                continue;

            var name = entMan.GetComponent<MetaDataComponent>(uid).EntityName;
            var fileName = $"{ReplayToolsCommon.SafeFileName(name)}_{net.Id}_t{tick}.yml";
            var userPath = new ResPath($"/replay_export/{fileName}");

            if (!mapLoader.TrySaveGrid(uid, userPath))
            {
                log.Error($"Could not save grid {name} ({net.Id})");
                continue;
            }

            using (var from = res.UserData.OpenRead(userPath))
            using (var to = File.Create(Path.Combine(outDir, fileName)))
                from.CopyTo(to);
            res.UserData.Delete(userPath);

            if (saved > 0)
                listing.Append(",\n");
            listing.Append("  {")
                .Append($"\"file\": {ReplayToolsCommon.JsonString(fileName)}, ")
                .Append($"\"name\": {ReplayToolsCommon.JsonString(name)}, ")
                .Append($"\"netEntity\": {net.Id}, \"tick\": {tick}, ")
                .Append($"\"seconds\": {seconds.ToString("0.###", CultureInfo.InvariantCulture)}")
                .Append('}');
            saved++;
            log.Info($"Saved {fileName}");
        }

        listing.Append("\n]\n");
        File.WriteAllText(Path.Combine(outDir, "grids.json"), listing.ToString());
        return saved;
    }

    public static string Stamp(TimeSpan t) =>
        $"{(int) t.TotalHours:00}h{t.Minutes:00}m{t.Seconds:00}s";
}

public sealed class ReplayExportGridsCommand : IConsoleCommand
{
    public string Command => "replay_export_grids";
    public string Description => "Load a replay headless, save its grids at a given time as map .yml files, then quit.";
    public string Help => "replay_export_grids <replay.zip|-> <seconds> <outDir|-> [gridNetEntity]   (- = from REPLAYTOOLS_REPLAY / REPLAYTOOLS_OUT)";

    public void Execute(IConsoleShell shell, string argStr, string[] args)
    {
        if (args.Length < 3)
        {
            shell.WriteError(Help);
            return;
        }

        if (!double.TryParse(args[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) || seconds < 0)
        {
            shell.WriteError("seconds must be a number >= 0");
            return;
        }

        int? onlyGrid = null;
        if (args.Length > 3)
        {
            if (!int.TryParse(args[3], out var id))
            {
                shell.WriteError("gridNetEntity must be a number");
                return;
            }
            onlyGrid = id;
        }

        string replay, outDir;
        try
        {
            replay = ReplayToolsCommon.PathArg(args[0], ReplayToolsCommon.EnvReplay);
            outDir = ReplayToolsCommon.PathArg(args[2], ReplayToolsCommon.EnvOut);
        }
        catch (ArgumentException e)
        {
            shell.WriteError(e.Message);
            Console.WriteLine($"{ReplayToolsCommon.FailMarker}: {e.Message}");
            return;
        }

        _ = RunGuarded(replay, seconds, outDir, onlyGrid);
    }

    private static async Task RunGuarded(string replayPath, double seconds, string outDir, int? onlyGrid)
    {
        var log = IoCManager.Resolve<ILogManager>().GetSawmill("replaytools");
        try
        {
            await Run(log, replayPath, seconds, outDir, onlyGrid);
            Console.WriteLine(ReplayToolsCommon.DoneMarker);
        }
        catch (Exception e)
        {
            log.Error($"replay_export_grids failed: {e}");
            Console.WriteLine($"{ReplayToolsCommon.FailMarker}: {e.Message}");
        }
        finally
        {
            IoCManager.Resolve<IGameController>().Shutdown("replay_export_grids finished");
        }
    }

    private static async Task Run(ISawmill log, string replayPath, double seconds, string outDir, int? onlyGrid)
    {
        var loadMan = IoCManager.Resolve<IReplayLoadManager>();
        var playback = IoCManager.Resolve<IReplayPlaybackManager>();

        var zip = new ZipArchive(File.OpenRead(replayPath), ZipArchiveMode.Read);
        var reader = new ReplayFileReaderZip(zip, ReplayConstants.ReplayZipFolder);
        log.Info("Loading and starting replay...");
        await loadMan.LoadAndStartReplayAsync(reader, (current, max, _, _) =>
        {
            ReplayToolsCommon.Progress("load", current, max);
            return Task.CompletedTask;
        });

        var replay = playback.Replay ?? throw new Exception("Replay did not start");
        var target = TimeSpan.FromSeconds(seconds);
        var length = replay.ReplayTime[^1];
        if (target > length)
        {
            log.Warning($"{seconds}s is past the end ({length.TotalSeconds:0.#}s), using the end.");
            target = length;
        }

        playback.Playing = false;
        playback.SetTime(target);
        log.Info($"At {replay.CurrentReplayTime.TotalSeconds:0.###}s, tick {replay.CurTick}.");

        var saved = GridSaver.SaveAll(log, outDir, onlyGrid, replay);
        if (saved == 0)
            throw new Exception(onlyGrid == null ? "No grids found at that time" : $"Grid {onlyGrid} not found at that time");
        log.Info($"Done: {saved} grid(s) saved to {outDir}");
    }
}

public sealed class SaveGridsNowCommand : IConsoleCommand
{
    public string Command => "savegrids";
    public string Description => "Save every grid of the replay you are watching, at this exact moment, as map .yml files.";
    public string Help => "savegrids [outDir|-] [gridNetEntity]";

    public void Execute(IConsoleShell shell, string argStr, string[] args)
    {
        var playback = IoCManager.Resolve<IReplayPlaybackManager>();
        var replay = playback.Replay;
        if (replay == null)
        {
            shell.WriteError("No replay is playing.");
            return;
        }

        var baseDir = args.Length > 0 && args[0] != "-"
            ? args[0]
            : Environment.GetEnvironmentVariable(ReplayToolsCommon.EnvSaveDir)
              ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "SS14 replay saves");

        int? onlyGrid = null;
        if (args.Length > 1 && int.TryParse(args[1], out var id))
            onlyGrid = id;

        var log = IoCManager.Resolve<ILogManager>().GetSawmill("replaytools");
        var outDir = Path.Combine(baseDir, $"t{GridSaver.Stamp(replay.CurrentReplayTime)}_tick{replay.CurTick.Value}");
        try
        {
            var saved = GridSaver.SaveAll(log, outDir, onlyGrid, replay);
            shell.WriteLine(saved == 0 ? "No grids found." : $"Saved {saved} grid(s) to {outDir}");
        }
        catch (Exception e)
        {
            shell.WriteError($"Saving failed: {e.Message}");
            log.Error($"savegrids failed: {e}");
        }
    }
}
