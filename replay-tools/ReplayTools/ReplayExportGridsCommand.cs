// replay_export_grids <replay.zip> <seconds> <outDir> [gridNetEntity]
//
// Loads a replay (a full one or a chunk from replay_chunk), jumps to <seconds> after its start (any
// tick, not only chunk boundaries), and saves every grid (or only the given one) as a map .yml.
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

public sealed class ReplayExportGridsCommand : IConsoleCommand
{
    public string Command => "replay_export_grids";
    public string Description => "Save the grids of a replay at a given time as map .yml files.";
    public string Help => "replay_export_grids <replay.zip> <seconds> <outDir> [gridNetEntity]";

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

        _ = RunGuarded(args[0], seconds, args[2], onlyGrid);
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
        var entMan = IoCManager.Resolve<IEntityManager>();
        var res = IoCManager.Resolve<IResourceManager>();

        Directory.CreateDirectory(outDir);

        var zip = new ZipArchive(File.OpenRead(replayPath), ZipArchiveMode.Read);
        var reader = new ReplayFileReaderZip(zip, ReplayConstants.ReplayZipFolder);
        log.Info("Loading and starting replay...");
        await loadMan.LoadAndStartReplayAsync(reader);

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
        var tick = replay.CurTick;
        log.Info($"At {replay.CurrentReplayTime.TotalSeconds:0.###}s, tick {tick}.");

        var mapLoader = entMan.System<MapLoaderSystem>();
        var listing = new StringBuilder("[\n");
        var saved = 0;
        var query = entMan.EntityQueryEnumerator<MapGridComponent>();
        while (query.MoveNext(out var uid, out _))
        {
            var net = entMan.GetNetEntity(uid);
            if (onlyGrid != null && net.Id != onlyGrid.Value)
                continue;

            var name = entMan.GetComponent<MetaDataComponent>(uid).EntityName;
            var fileName = $"{ReplayToolsCommon.SafeFileName(name)}_{net.Id}_t{tick.Value}.yml";
            var userPath = new ResPath($"/replay_export/{fileName}");

            if (!mapLoader.TrySaveGrid(uid, userPath))
            {
                log.Error($"Could not save grid {name} ({net.Id})");
                continue;
            }

            using (var from = res.UserData.OpenRead(userPath))
            using (var to = File.Create(Path.Combine(outDir, fileName)))
                from.CopyTo(to);

            if (saved > 0)
                listing.Append(",\n");
            listing.Append("  {")
                .Append($"\"file\": {ReplayToolsCommon.JsonString(fileName)}, ")
                .Append($"\"name\": {ReplayToolsCommon.JsonString(name)}, ")
                .Append($"\"netEntity\": {net.Id}, \"tick\": {tick.Value}, ")
                .Append($"\"seconds\": {replay.CurrentReplayTime.TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture)}")
                .Append('}');
            saved++;
            log.Info($"Saved {fileName}");
        }

        listing.Append("\n]\n");
        File.WriteAllText(Path.Combine(outDir, "grids.json"), listing.ToString());

        if (saved == 0)
            throw new Exception(onlyGrid == null ? "No grids found at that time" : $"Grid {onlyGrid} not found at that time");
        log.Info($"Done: {saved} grid(s) saved to {outDir}");
    }
}
