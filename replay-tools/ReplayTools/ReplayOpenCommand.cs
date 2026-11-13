// replay_open <replay.zip|->
//   Opens a replay from any folder in the game window (the stock replay_load only reads the game's own
//   replays folder). "-" = path from REPLAYTOOLS_REPLAY, which the desktop app's "Open in game" sets.

using System;
using System.IO;
using System.IO.Compression;
using Robust.Client;
using Robust.Client.Replays.Loading;
using Robust.Client.Replays.Playback;
using Robust.Shared.Console;
using Robust.Shared.IoC;
using Robust.Shared.Replays;

namespace Content.Client._ReplayTools;

public sealed class ReplayOpenCommand : IConsoleCommand
{
    public string Command => "replay_open";
    public string Description => "Open a replay .zip from any folder.";
    public string Help => "replay_open <path to replay.zip|->";

    public void Execute(IConsoleShell shell, string argStr, string[] args)
    {
        var path = args.Length > 0 ? argStr.Trim().Trim('"') : "-";
        try
        {
            path = ReplayToolsCommon.PathArg(path, ReplayToolsCommon.EnvReplay);
        }
        catch (ArgumentException e)
        {
            shell.WriteError(e.Message);
            return;
        }

        if (!File.Exists(path))
        {
            shell.WriteError($"File not found: {path}");
            return;
        }

        if (IoCManager.Resolve<IReplayPlaybackManager>().Replay != null)
        {
            shell.WriteError("A replay is already open. Restart the game to open another one.");
            return;
        }

        var client = IoCManager.Resolve<IBaseClient>();
        if (client.RunLevel != ClientRunLevel.Initialize && client.RunLevel != ClientRunLevel.SinglePlayerGame)
        {
            shell.WriteError("Disconnect first (replays can only be opened from the main menu).");
            return;
        }

        var zip = new ZipArchive(File.OpenRead(path), ZipArchiveMode.Read);
        var reader = new ReplayFileReaderZip(zip, ReplayConstants.ReplayZipFolder);
        shell.WriteLine($"Opening {Path.GetFileName(path)}. Pause anywhere and type 'savegrids' to save the grids at that moment.");
        IoCManager.Resolve<IReplayLoadManager>().LoadAndStartReplay(reader);
    }
}
