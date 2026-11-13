using System.IO.Compression;
using System.Text.RegularExpressions;

namespace SS14ReplayTools;

/// <summary>Build info from a replay's _replay/replay.yml and replay_final.yml.</summary>
public sealed record ReplayInfo(
    string Path,
    long SizeBytes,
    string ForkId,
    string ForkVersion,
    string EngineVersion,
    string Name,
    string? RoundId,
    string? RecordedUtc,
    string? Duration,
    bool ClientRecording,
    int DataFiles)
{
    private static readonly Regex KeyLine = new(@"^([A-Za-z_]\w*):[ \t]*(.*)$", RegexOptions.Compiled);

    public bool CommitIsHash => Regex.IsMatch(ForkVersion, "^[0-9a-f]{40}$");

    public static ReplayInfo Read(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var meta = ReadKeys(zip, "_replay/replay.yml");
        if (meta.Count == 0)
            throw new InvalidDataException("This zip has no _replay/replay.yml, so it is not an SS14 replay.");
        var final = ReadKeys(zip, "_replay/replay_final.yml");
        var dataFiles = zip.Entries.Count(e => Regex.IsMatch(e.FullName, @"^_replay/data_\d+\.dat$"));

        return new ReplayInfo(
            path,
            new FileInfo(path).Length,
            meta.GetValueOrDefault("buildForkId", ""),
            meta.GetValueOrDefault("buildForkVersion", ""),
            meta.GetValueOrDefault("engineVersion", ""),
            meta.GetValueOrDefault("name", ""),
            meta.GetValueOrDefault("roundId"),
            meta.GetValueOrDefault("time"),
            final.GetValueOrDefault("duration"),
            meta.GetValueOrDefault("isClientRecording", "False").Equals("true", StringComparison.OrdinalIgnoreCase),
            dataFiles);
    }

    private static Dictionary<string, string> ReadKeys(ZipArchive zip, string name)
    {
        var result = new Dictionary<string, string>();
        var entry = zip.GetEntry(name);
        if (entry == null)
            return result;
        using var reader = new StreamReader(entry.Open());
        while (reader.ReadLine() is { } line)
        {
            var m = KeyLine.Match(line);
            if (m.Success)
                result[m.Groups[1].Value] = m.Groups[2].Value.Trim().Trim('\'', '"');
        }
        return result;
    }
}
