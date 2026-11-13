using System.Text.Json;
using System.Text.Json.Serialization;

namespace SS14ReplayTools;

/// <summary>One stored build: a fork's source at one commit, built with the replay tools added.</summary>
public sealed class BuildRecord
{
    public string Id { get; set; } = "";
    public string ForkId { get; set; } = "";
    public string Repo { get; set; } = "";
    public string Commit { get; set; } = "";
    public string? EngineVersion { get; set; }
    public string? SdkRequired { get; set; }
    public DateTime? CommitDateUtc { get; set; }
    public DateTime? BuiltUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
    /// <summary>building, ready or failed.</summary>
    public string Status { get; set; } = "building";
    public string? Error { get; set; }
    public long? SizeBytes { get; set; }
    /// <summary>Hash of the replay-tools sources this build was made with; a mismatch means rebuild the tools.</summary>
    public string? ToolsHash { get; set; }
}

public sealed class Settings
{
    public Dictionary<string, string> Repos { get; set; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["wizards"] = "https://github.com/space-wizards/space-station-14",
        ["starlight"] = "https://github.com/ss14Starlight/space-station-14",
    };

    public string? LastDir { get; set; }
}

public sealed class BuildStore
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly object _lock = new();
    public string DataDir { get; }
    public string BuildsDir => Path.Combine(DataDir, "builds");
    private string SettingsPath => Path.Combine(DataDir, "settings.json");

    public BuildStore(string dataDir)
    {
        DataDir = dataDir;
        Directory.CreateDirectory(BuildsDir);
    }

    public static string MakeId(string forkId, string commit)
    {
        var fork = new string(forkId.Select(c => char.IsAsciiLetterOrDigit(c) || c == '-' ? char.ToLowerInvariant(c) : '_').ToArray());
        return $"{(fork.Length == 0 ? "unknown" : fork)}-{commit[..Math.Min(12, commit.Length)]}";
    }

    public string BuildDir(string id) => Path.Combine(BuildsDir, id);
    public string SourceDir(string id) => Path.Combine(BuildDir(id), "src");
    private string RecordPath(string id) => Path.Combine(BuildDir(id), "build.json");

    public string ClientExe(string id)
    {
        var dir = Path.Combine(SourceDir(id), "bin", "Content.Client");
        return Path.Combine(dir, OperatingSystem.IsWindows() ? "Content.Client.exe" : "Content.Client");
    }

    public BuildRecord? Get(string id)
    {
        lock (_lock)
        {
            var path = RecordPath(id);
            if (!File.Exists(path))
                return null;
            try
            {
                return JsonSerializer.Deserialize<BuildRecord>(File.ReadAllText(path), Json);
            }
            catch
            {
                return null;
            }
        }
    }

    public void Save(BuildRecord record)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(BuildDir(record.Id));
            var tmp = RecordPath(record.Id) + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(record, Json));
            File.Move(tmp, RecordPath(record.Id), true);
        }
    }

    public List<BuildRecord> List()
    {
        var list = new List<BuildRecord>();
        foreach (var dir in Directory.EnumerateDirectories(BuildsDir))
        {
            var id = Path.GetFileName(dir);
            var rec = Get(id) ?? new BuildRecord
            {
                Id = id,
                Status = "failed",
                Error = "build.json missing (interrupted?)",
            };
            list.Add(rec);
        }
        return list;
    }

    public void Delete(string id)
    {
        var dir = BuildDir(id);
        if (!Directory.Exists(dir))
            return;
        // Git marks pack files read-only, which blocks deletion on Windows.
        foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            try
            {
                File.SetAttributes(file, FileAttributes.Normal);
            }
            catch
            {
                // best effort
            }
        }
        Directory.Delete(dir, true);
    }

    public static long DirSize(string dir)
    {
        if (!Directory.Exists(dir))
            return 0;
        long total = 0;
        var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", opts))
            total += f.Length;
        return total;
    }

    public Settings LoadSettings()
    {
        lock (_lock)
        {
            try
            {
                if (File.Exists(SettingsPath))
                {
                    var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsPath), Json);
                    if (s != null)
                    {
                        // Keep defaults for forks the user hasn't overridden.
                        var defaults = new Settings();
                        var merged = new Dictionary<string, string>(defaults.Repos, StringComparer.OrdinalIgnoreCase);
                        foreach (var (k, v) in s.Repos)
                            merged[k] = v;
                        s.Repos = merged;
                        return s;
                    }
                }
            }
            catch
            {
                // fall through to defaults
            }
            return new Settings();
        }
    }

    public void SaveSettings(Settings settings)
    {
        lock (_lock)
        {
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, Json));
        }
    }
}
