// replay_chunk <replay.zip> <outDir> [seconds=60]
//
// Splits a server replay into short replays of <seconds> each. Every chunk starts from the engine's own
// checkpoint (a full game state) at that point and carries the following ticks unchanged, so each chunk
// plays in the normal replay player and needs only that chunk's memory.
//
// How it works:
//  1. Force the engine to make a checkpoint exactly every <seconds> * tickrate ticks, then load the replay
//     with IReplayLoadManager (this also checks the type hash, so a wrong build fails here).
//  2. Read the original data files again, raw, and write ticks into the current chunk. At each checkpoint
//     index, close the chunk and open a new one whose first state is that checkpoint's full state.
//  3. Each chunk gets: replay.yml with new start tick/time and time base, replay_final.yml, cvars.toml with
//     the cvar values at the checkpoint, init.dat with every prototype/resource upload sent before the
//     chunk, the original strings.dat, and any other files the original zip had.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Robust.Client;
using Robust.Client.Replays.Loading;
using Robust.Shared;
using Robust.Shared.Configuration;
using Robust.Shared.Console;
using Robust.Shared.GameStates;
using Robust.Shared.IoC;
using Robust.Shared.Log;
using Robust.Shared.Replays;
using Robust.Shared.Serialization;
using Robust.Shared.Timing;

namespace Content.Client._ReplayTools;

public sealed class ReplayChunkCommand : IConsoleCommand
{
    public string Command => "replay_chunk";
    public string Description => "Split a replay into short replays that each start from a full state.";
    public string Help => "replay_chunk <replay.zip> <outDir> [seconds=60]";

    public void Execute(IConsoleShell shell, string argStr, string[] args)
    {
        if (args.Length < 2)
        {
            shell.WriteError(Help);
            return;
        }

        var seconds = 60;
        if (args.Length > 2 && (!int.TryParse(args[2], out seconds) || seconds < 1))
        {
            shell.WriteError("seconds must be a whole number >= 1");
            return;
        }

        _ = RunGuarded(shell, args[0], args[1], seconds);
    }

    private static async Task RunGuarded(IConsoleShell shell, string replayPath, string outDir, int seconds)
    {
        var log = IoCManager.Resolve<ILogManager>().GetSawmill("replaytools");
        try
        {
            await Run(log, replayPath, outDir, seconds);
            Console.WriteLine(ReplayToolsCommon.DoneMarker);
        }
        catch (Exception e)
        {
            log.Error($"replay_chunk failed: {e}");
            Console.WriteLine($"{ReplayToolsCommon.FailMarker}: {e.Message}");
        }
        finally
        {
            IoCManager.Resolve<IGameController>().Shutdown("replay_chunk finished");
        }
    }

    private static async Task Run(ISawmill log, string replayPath, string outDir, int seconds)
    {
        var cfg = IoCManager.Resolve<IConfigurationManager>();
        var ser = IoCManager.Resolve<IRobustSerializer>();
        var loadMan = IoCManager.Resolve<IReplayLoadManager>();

        Directory.CreateDirectory(outDir);
        using var srcZip = new ZipArchive(File.OpenRead(replayPath), ZipArchiveMode.Read);
        var tickrate = ReadTickrate(ReplayToolsCommon.ReadText(srcZip, ReplayToolsCommon.Folder + ReplayConstants.FileCvars));
        var chunkTicks = seconds * tickrate;
        log.Info($"tickrate {tickrate}, chunk = {seconds}s = {chunkTicks} ticks");

        // One checkpoint exactly every chunkTicks ticks and none in between.
        cfg.SetCVar(CVars.CheckpointMinInterval, chunkTicks);
        cfg.SetCVar(CVars.CheckpointInterval, chunkTicks);
        cfg.SetCVar(CVars.CheckpointEntitySpawnThreshold, int.MaxValue);
        cfg.SetCVar(CVars.CheckpointEntityStateThreshold, int.MaxValue);

        // The load manager keeps its own zip open (newer engines read from it lazily during playback).
        var loadZip = new ZipArchive(File.OpenRead(replayPath), ZipArchiveMode.Read);
        var reader = new ReplayFileReaderZip(loadZip, ReplayConstants.ReplayZipFolder);
        log.Info("Loading replay and building checkpoints...");
        var data = await loadMan.LoadReplayAsync(reader, (_, _, _, _) => Task.CompletedTask);
        var checkpoints = data.Checkpoints.OrderBy(c => c.Index).ToArray();
        log.Info($"Loaded. {checkpoints.Length} checkpoints, ticks from {data.TickOffset}.");

        var metaText = ReplayToolsCommon.ReadText(srcZip, ReplayToolsCommon.Folder + ReplayConstants.FileMeta);
        var rawInit = ReplayToolsCommon.ReadInit(srcZip, ser);
        var baseName = Path.GetFileNameWithoutExtension(replayPath);

        var skip = new HashSet<string>
        {
            ReplayToolsCommon.Folder + ReplayConstants.FileMeta,
            ReplayToolsCommon.Folder + ReplayConstants.FileMetaFinal,
            ReplayToolsCommon.Folder + ReplayConstants.FileCvars,
            ReplayToolsCommon.Folder + ReplayConstants.FileInit,
        };
        var dataFile = new Regex(@"^_replay/data_\d+\.dat$");
        var extraEntries = srcZip.Entries
            .Where(e => !skip.Contains(e.FullName) && !dataFile.IsMatch(e.FullName))
            .ToList();

        var uploadsSoFar = new List<object>();
        var index = new StringBuilder("[\n");

        ReplayZipWriter? writer = null;
        CheckpointState? current = null;
        string? currentFile = null;
        var chunkNumber = 0;
        var nextCheckpoint = 0;
        var lastTick = GameTick.Zero;

        void CloseChunk(GameTick endTick)
        {
            if (writer == null || current == null || currentFile == null)
                return;

            writer.Flush();
            var start = TimeAt(current, current.Tick, tickrate);
            var end = TimeAt(current, endTick, tickrate);
            var final = new StringBuilder()
                .Append($"{ReplayConstants.MetaFinalKeyEndTick}: {endTick.Value}\n")
                .Append($"{ReplayConstants.MetaFinalKeyDuration}: {(end - start).ToString("c", CultureInfo.InvariantCulture)}\n")
                .Append($"{ReplayConstants.MetaFinalKeyFileCount}: {writer.FileCount}\n")
                .Append($"{ReplayConstants.MetaFinalKeyCompressedSize}: {writer.CompressedSize}\n")
                .Append($"{ReplayConstants.MetaFinalKeyUncompressedSize}: {writer.UncompressedSize}\n")
                .Append($"{ReplayConstants.MetaFinalKeyEndTime}: {end.ToString("c", CultureInfo.InvariantCulture)}\n");
            writer.WriteText(ReplayToolsCommon.Folder + ReplayConstants.FileMetaFinal, final.ToString());
            writer.Dispose();

            var replayStart = TimeAt(checkpoints[0], checkpoints[0].Tick, tickrate);
            if (chunkNumber > 1)
                index.Append(",\n");
            index.Append("  {")
                .Append($"\"file\": {ReplayToolsCommon.JsonString(Path.GetFileName(currentFile))}, ")
                .Append($"\"chunk\": {chunkNumber - 1}, ")
                .Append($"\"startTick\": {current.Tick.Value}, \"endTick\": {endTick.Value}, ")
                .Append($"\"startSeconds\": {(start - replayStart).TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture)}, ")
                .Append($"\"endSeconds\": {(end - replayStart).TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture)}")
                .Append('}');
            log.Info($"Wrote {currentFile} ({writer.CompressedSize / 1024} KiB of tick data)");
            writer = null;
        }

        void OpenChunk(CheckpointState checkpoint)
        {
            var replayStart = TimeAt(checkpoints[0], checkpoints[0].Tick, tickrate);
            var offset = TimeAt(checkpoint, checkpoint.Tick, tickrate) - replayStart;
            currentFile = Path.Combine(outDir,
                $"{baseName}_chunk{chunkNumber:000}_{(int) offset.TotalMinutes:000}m{offset.Seconds:00}s.zip");
            chunkNumber++;
            current = checkpoint;
            writer = new ReplayZipWriter(currentFile, ser);

            foreach (var entry in extraEntries)
                writer.CopyEntry(entry);

            writer.WriteText(ReplayToolsCommon.Folder + ReplayConstants.FileMeta,
                RewriteMeta(metaText, checkpoint, tickrate, chunkNumber - 1));
            writer.WriteText(ReplayToolsCommon.Folder + ReplayConstants.FileCvars,
                ReplayToolsCommon.CvarsToToml(checkpoint.Cvars));

            var init = new List<object>();
            if (rawInit != null)
                init.AddRange(rawInit.Messages);
            init.AddRange(uploadsSoFar);
            if (init.Count > 0)
                writer.WriteSerialized(ReplayToolsCommon.Folder + ReplayConstants.FileInit, new ReplayMessage { Messages = init });

            // The checkpoint's full state is the chunk's first tick.
            writer.AddTick(checkpoint.FullState, new ReplayMessage { Messages = new List<object>() });
        }

        var i = -1;
        foreach (var (state, messages) in ReplayToolsCommon.ReadRaw(srcZip, ser))
        {
            i++;
            lastTick = state.ToSequence;

            if (nextCheckpoint < checkpoints.Length && checkpoints[nextCheckpoint].Index == i)
            {
                // This tick ends the previous chunk and is the full first state of the next one.
                if (writer != null)
                    writer.AddTick(state, messages);
                CloseChunk(state.ToSequence);

                foreach (var m in messages.Messages)
                {
                    if (ReplayToolsCommon.IsUpload(m))
                        uploadsSoFar.Add(m);
                }

                OpenChunk(checkpoints[nextCheckpoint]);
                nextCheckpoint++;
                continue;
            }

            foreach (var m in messages.Messages)
            {
                if (ReplayToolsCommon.IsUpload(m))
                    uploadsSoFar.Add(m);
            }

            writer?.AddTick(state, messages);
        }

        CloseChunk(lastTick);
        index.Append("\n]\n");
        File.WriteAllText(Path.Combine(outDir, "chunks.json"), index.ToString());

        if (nextCheckpoint != checkpoints.Length)
            log.Warning($"Only {nextCheckpoint} of {checkpoints.Length} checkpoints matched a tick index.");
        log.Info($"Done: {chunkNumber} chunks in {outDir}");
    }

    private static int ReadTickrate(string cvarsToml)
    {
        // [net] table, "tickrate = N". Fall back to the usual 30 if it isn't there.
        var inNet = false;
        foreach (var raw in cvarsToml.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith('['))
            {
                inNet = line == "[net]";
                continue;
            }

            if (inNet && line.StartsWith("tickrate"))
            {
                var m = Regex.Match(line, @"^tickrate\s*=\s*(\d+)");
                if (m.Success)
                    return int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            }

            var dotted = Regex.Match(line, @"^net\.tickrate\s*=\s*(\d+)");
            if (dotted.Success)
                return int.Parse(dotted.Groups[1].Value, CultureInfo.InvariantCulture);
        }

        return 30;
    }

    private static TimeSpan TimeAt(CheckpointState checkpoint, GameTick tick, int tickrate)
    {
        var rate = checkpoint.Cvars.TryGetValue(CVars.NetTickrate.Name, out var r) ? Convert.ToInt32(r) : tickrate;
        var period = TimeSpan.FromTicks(TimeSpan.TicksPerSecond / rate);
        var (baseTime, baseTick) = checkpoint.TimeBase;
        return baseTime + ((long) tick.Value - baseTick.Value) * period;
    }

    private static string RewriteMeta(string meta, CheckpointState checkpoint, int tickrate, int chunk)
    {
        var (baseTime, baseTick) = checkpoint.TimeBase;
        var startTime = TimeAt(checkpoint, checkpoint.Tick, tickrate);

        meta = SetKey(meta, ReplayConstants.MetaKeyStartTick, checkpoint.Tick.Value.ToString(CultureInfo.InvariantCulture));
        meta = SetKey(meta, ReplayConstants.MetaKeyBaseTick, baseTick.Value.ToString(CultureInfo.InvariantCulture));
        meta = SetKey(meta, ReplayConstants.MetaKeyBaseTime, baseTime.Ticks.ToString(CultureInfo.InvariantCulture));
        meta = SetKey(meta, ReplayConstants.MetaKeyStartTime, startTime.ToString("c", CultureInfo.InvariantCulture));

        var name = Regex.Match(meta, $@"^{ReplayConstants.MetaKeyName}:[ \t]*(.*)$", RegexOptions.Multiline);
        var oldName = name.Success ? name.Groups[1].Value.Trim().Trim('\'', '"') : "replay";
        meta = SetKey(meta, ReplayConstants.MetaKeyName, $"'{oldName.Replace("'", "''")} [chunk {chunk}]'");
        return meta;
    }

    private static string SetKey(string yaml, string key, string value)
    {
        var re = new Regex($@"^{Regex.Escape(key)}:[ \t]*.*$", RegexOptions.Multiline);
        if (re.IsMatch(yaml))
            return re.Replace(yaml, _ => $"{key}: {value}", 1);
        return yaml.TrimEnd('\n', '\r') + $"\n{key}: {value}\n";
    }
}
