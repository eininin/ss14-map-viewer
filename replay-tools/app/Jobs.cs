using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SS14ReplayTools;

public sealed class Job
{
    private readonly List<string> _log = new();
    private readonly object _lock = new();

    public string Id { get; } = Guid.NewGuid().ToString("N")[..10];
    public required string Kind { get; init; }       // build, chunk, export
    public required string Title { get; init; }
    public string Status { get; set; } = "queued";    // queued, running, done, failed, cancelled
    public string? Step { get; set; }
    public string? BuildId { get; set; }
    public string? OutDir { get; set; }
    public double? Progress { get; set; }             // 0..1 when known
    public long? PeakMemoryBytes { get; set; }
    public string? Error { get; set; }
    public DateTime CreatedUtc { get; } = DateTime.UtcNow;
    public DateTime? StartedUtc { get; set; }
    public DateTime? EndedUtc { get; set; }
    public CancellationTokenSource Cancel { get; } = new();

    public void Log(string line)
    {
        lock (_lock)
        {
            _log.Add(line);
            // Keep memory bounded: drop the oldest lines of very chatty runs.
            if (_log.Count > 20000)
                _log.RemoveRange(0, 5000);
        }
    }

    public (int Total, List<string> Lines) LinesFrom(int from)
    {
        lock (_lock)
        {
            from = Math.Clamp(from, 0, _log.Count);
            return (_log.Count, _log.GetRange(from, _log.Count - from));
        }
    }

    public object Summary() => new
    {
        Id, Kind, Title, Status, Step, BuildId, OutDir, Progress, PeakMemoryBytes, Error,
        CreatedUtc, StartedUtc, EndedUtc,
    };
}

public sealed class JobRunner
{
    private readonly BuildStore _store;
    private readonly List<Job> _jobs = new();
    // Builds and replay runs both use a lot of RAM/CPU, so they run one at a time.
    private readonly SemaphoreSlim _heavy = new(1, 1);
    private readonly object _lock = new();

    public JobRunner(BuildStore store) => _store = store;

    public List<Job> All()
    {
        lock (_lock)
            return _jobs.OrderByDescending(j => j.CreatedUtc).ToList();
    }

    public Job? Get(string id)
    {
        lock (_lock)
            return _jobs.FirstOrDefault(j => j.Id == id);
    }

    public bool BuildInUse(string buildId)
    {
        lock (_lock)
            return _jobs.Any(j => j.BuildId == buildId && j.Status is "queued" or "running");
    }

    public Job Start(Job job, Func<Job, Task> work)
    {
        lock (_lock)
            _jobs.Add(job);

        _ = Task.Run(async () =>
        {
            try
            {
                await _heavy.WaitAsync(job.Cancel.Token);
                try
                {
                    job.Status = "running";
                    job.StartedUtc = DateTime.UtcNow;
                    await work(job);
                    job.Status = "done";
                    job.Progress = 1;
                }
                finally
                {
                    _heavy.Release();
                }
            }
            catch (OperationCanceledException)
            {
                job.Status = "cancelled";
                job.Log("Cancelled.");
            }
            catch (Exception e)
            {
                job.Status = "failed";
                job.Error = e.Message;
                job.Log("ERROR: " + e.Message);
            }
            finally
            {
                job.EndedUtc = DateTime.UtcNow;
            }
        });
        return job;
    }

    // ---------------------------------------------------------------- tools sources

    public static IReadOnlyList<(string Name, byte[] Data)> ToolSources()
    {
        var asm = Assembly.GetExecutingAssembly();
        var list = new List<(string, byte[])>();
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith("tools/")).OrderBy(n => n))
        {
            using var s = asm.GetManifestResourceStream(name)!;
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            list.Add((name["tools/".Length..], ms.ToArray()));
        }
        return list;
    }

    public static string ToolsHash()
    {
        using var sha = SHA256.Create();
        foreach (var (name, data) in ToolSources())
        {
            var n = Encoding.UTF8.GetBytes(name);
            sha.TransformBlock(n, 0, n.Length, null, 0);
            sha.TransformBlock(data, 0, data.Length, null, 0);
        }
        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!)[..16];
    }

    // ---------------------------------------------------------------- building

    /// <summary>Makes sure a ready build exists for this fork+commit (with current tools), building it if needed.</summary>
    public async Task<BuildRecord> EnsureBuild(Job job, string forkId, string repo, string commit)
    {
        var id = BuildStore.MakeId(forkId, commit);
        job.BuildId = id;
        var rec = _store.Get(id);
        var toolsHash = ToolsHash();

        if (rec is { Status: "ready" } && rec.ToolsHash == toolsHash && File.Exists(_store.ClientExe(id)))
        {
            job.Log($"Using stored build {id}.");
            rec.LastUsedUtc = DateTime.UtcNow;
            _store.Save(rec);
            return rec;
        }

        rec ??= new BuildRecord { Id = id };
        rec.ForkId = forkId;
        rec.Repo = repo;
        rec.Commit = commit;
        rec.Status = "building";
        rec.Error = null;
        _store.Save(rec);

        try
        {
            await Build(job, rec, toolsHash);
            rec.Status = "ready";
            rec.BuiltUtc = DateTime.UtcNow;
            rec.LastUsedUtc = DateTime.UtcNow;
            rec.ToolsHash = toolsHash;
            job.Step = "Measuring build size";
            rec.SizeBytes = BuildStore.DirSize(_store.BuildDir(id));
            _store.Save(rec);
            return rec;
        }
        catch (Exception e)
        {
            rec.Status = "failed";
            rec.Error = job.Cancel.IsCancellationRequested ? "cancelled" : e.Message;
            rec.SizeBytes = BuildStore.DirSize(_store.BuildDir(id));
            _store.Save(rec);
            throw;
        }
    }

    private async Task Build(Job job, BuildRecord rec, string toolsHash)
    {
        var src = _store.SourceDir(rec.Id);
        var ct = job.Cancel.Token;

        if (!Directory.Exists(Path.Combine(src, ".git")) || !await HasCommit(src, rec.Commit, ct))
        {
            job.Step = "Downloading source";
            Directory.CreateDirectory(src);
            if (!Directory.Exists(Path.Combine(src, ".git")))
            {
                await Run(job, "git", new[] { "init", "-q" }, src);
                await Run(job, "git", new[] { "remote", "add", "origin", rec.Repo }, src);
            }
            else
            {
                await Run(job, "git", new[] { "remote", "set-url", "origin", rec.Repo }, src);
            }

            if (await Run(job, "git", new[] { "fetch", "--depth", "1", "origin", rec.Commit }, src, check: false) != 0)
            {
                throw new Exception($"Could not download commit {rec.Commit} from {rec.Repo}. " +
                                    "Is this the right repository for this server?");
            }
        }

        await Run(job, "git", new[] { "checkout", "-q", "--force", rec.Commit }, src);

        job.Step = "Downloading engine and submodules";
        if (await Run(job, "git", new[] { "submodule", "update", "--init", "--recursive", "--depth", "1" }, src, check: false) != 0)
        {
            job.Log("Shallow submodule download failed, trying full history...");
            await Run(job, "git", new[] { "submodule", "update", "--init", "--recursive" }, src);
        }

        rec.EngineVersion = ReadEngineVersion(src);
        rec.SdkRequired = ReadSdkVersion(src);
        var date = (await Capture("git", new[] { "log", "-1", "--format=%cI" }, src, ct)).Trim();
        if (DateTimeOffset.TryParse(date, out var dto))
            rec.CommitDateUtc = dto.UtcDateTime;
        _store.Save(rec);
        job.Log($"Engine {rec.EngineVersion}, .NET SDK {rec.SdkRequired ?? "?"}, commit date {rec.CommitDateUtc:yyyy-MM-dd}.");

        job.Step = "Adding replay tools";
        var toolsDir = Path.Combine(src, "Content.Client", "_ReplayTools");
        if (Directory.Exists(toolsDir))
            Directory.Delete(toolsDir, true);
        Directory.CreateDirectory(toolsDir);
        foreach (var (name, data) in ToolSources())
            await File.WriteAllBytesAsync(Path.Combine(toolsDir, name), data, ct);

        job.Step = "Compiling (a few minutes the first time)";
        var csproj = Path.Combine(src, "Content.Client", "Content.Client.csproj");
        var buildArgs = new[] { "build", csproj, "-c", "Release", "-nologo", "-v", "minimal", "-clp:NoSummary" };
        var noNetwork = false;
        var noSdk = false;
        void Watch(string line)
        {
            if (line.Contains("NU1301") || line.Contains("Unable to load the service index"))
                noNetwork = true;
            if (line.Contains("compatible .NET SDK was not found") || line.Contains("A compatible installed .NET SDK"))
                noSdk = true;
        }
        var code = await Run(job, "dotnet", buildArgs, src, check: false, onLine: Watch);
        if (code != 0)
        {
            if (noSdk)
                throw new Exception($"This server version needs the .NET SDK {rec.SdkRequired ?? "named in its global.json"}. " +
                                    "Install it from dotnet.microsoft.com, restart this program and try again.");
            if (noNetwork)
                throw new Exception("Could not download packages from nuget.org. Check your internet connection and try again.");
            throw new Exception("Compiling failed - see the log for the first 'error' line.");
        }

        if (!File.Exists(_store.ClientExe(rec.Id)))
            throw new Exception($"Build finished but {_store.ClientExe(rec.Id)} is missing.");
        job.Log($"Build ready (tools {toolsHash}).");
    }

    private static async Task<bool> HasCommit(string src, string commit, CancellationToken ct)
    {
        try
        {
            var r = (await Capture("git", new[] { "cat-file", "-t", commit }, src, ct)).Trim();
            return r == "commit";
        }
        catch
        {
            return false;
        }
    }

    private static string? ReadEngineVersion(string src)
    {
        var props = Path.Combine(src, "RobustToolbox", "MSBuild", "Robust.Engine.Version.props");
        if (!File.Exists(props))
            return null;
        var m = Regex.Match(File.ReadAllText(props), "<Version>([^<]+)</Version>");
        return m.Success ? m.Groups[1].Value : null;
    }

    private static string? ReadSdkVersion(string src)
    {
        var path = Path.Combine(src, "global.json");
        if (!File.Exists(path))
            return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return doc.RootElement.GetProperty("sdk").GetProperty("version").GetString();
        }
        catch
        {
            return null;
        }
    }

    // ---------------------------------------------------------------- running the tools

    public async Task RunTool(Job job, BuildRecord build, string replayPath, string outDir, string command, int? expectedSteps)
    {
        job.Step = "Running replay tool";
        job.OutDir = outDir;
        Directory.CreateDirectory(outDir);

        var exe = _store.ClientExe(build.Id);
        var env = new Dictionary<string, string>
        {
            ["ROBUST_DISABLE_SANDBOX"] = "1",
            ["REPLAYTOOLS_REPLAY"] = Path.GetFullPath(replayPath),
            ["REPLAYTOOLS_OUT"] = Path.GetFullPath(outDir),
        };

        var done = false;
        var steps = 0;
        string? fail = null;

        void OnLine(string line)
        {
            if (line.Contains("REPLAYTOOLS_DONE"))
                done = true;
            var f = line.IndexOf("REPLAYTOOLS_FAILED", StringComparison.Ordinal);
            if (f >= 0)
                fail = line[f..];
            if (line.Contains("Begin checkpoint generation") || line.Contains("Loading replay"))
                job.Step = "Loading replay (reading every tick once)";
            if (line.Contains("Wrote ") || line.Contains("Saved "))
            {
                steps++;
                job.Step = $"Writing ({steps}{(expectedSteps is > 0 ? $" of ~{expectedSteps}" : "")})";
                if (expectedSteps is > 0)
                    job.Progress = Math.Min(0.99, (double) steps / expectedSteps.Value);
            }
        }

        // --self-contained keeps the game's config/logs inside the build folder, away from your real game.
        var args = new[] { "--headless", "--self-contained", "+" + command };
        await Run(job, exe, args, Path.GetDirectoryName(exe)!, check: false, env: env, onLine: OnLine, trackMemory: true);

        if (fail != null)
            throw new Exception(fail.Replace("REPLAYTOOLS_FAILED: ", ""));
        if (!done)
            throw new Exception("The game client exited without finishing - see the log.");
    }

    // ---------------------------------------------------------------- process helpers

    public static async Task<int> Run(Job job, string file, IEnumerable<string> args, string workDir, bool check = true,
        Dictionary<string, string>? env = null, Action<string>? onLine = null, bool trackMemory = false)
    {
        var psi = new ProcessStartInfo(file)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args)
            psi.ArgumentList.Add(a);
        if (env != null)
        {
            foreach (var (k, v) in env)
                psi.Environment[k] = v;
        }
        // Keep git from opening credential prompts for public repos.
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";

        job.Log($"> {Path.GetFileName(file)} {string.Join(' ', psi.ArgumentList.Select(a => a.Contains(' ') ? $"\"{a}\"" : a))}");

        using var proc = new Process { StartInfo = psi };
        void Handle(object _, DataReceivedEventArgs e)
        {
            if (e.Data == null)
                return;
            job.Log(e.Data);
            onLine?.Invoke(e.Data);
        }
        proc.OutputDataReceived += Handle;
        proc.ErrorDataReceived += Handle;

        try
        {
            proc.Start();
        }
        catch (Exception e)
        {
            throw new Exception($"Could not start '{file}': {e.Message}. Is it installed?");
        }

        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        using var reg = job.Cancel.Token.Register(() =>
        {
            try
            {
                proc.Kill(true);
            }
            catch
            {
                // already gone
            }
        });

        Task? memTask = null;
        using var memStop = new CancellationTokenSource();
        if (trackMemory)
        {
            memTask = Task.Run(async () =>
            {
                while (!memStop.IsCancellationRequested)
                {
                    try
                    {
                        proc.Refresh();
                        var peak = Math.Max(proc.PeakWorkingSet64, proc.WorkingSet64);
                        if (peak > (job.PeakMemoryBytes ?? 0))
                            job.PeakMemoryBytes = peak;
                    }
                    catch
                    {
                        break;
                    }
                    try
                    {
                        await Task.Delay(1000, memStop.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            });
        }

        await proc.WaitForExitAsync();
        memStop.Cancel();
        if (memTask != null)
            await memTask;

        job.Cancel.Token.ThrowIfCancellationRequested();
        if (check && proc.ExitCode != 0)
            throw new Exception($"{Path.GetFileName(file)} failed (exit code {proc.ExitCode}) - see the log.");
        return proc.ExitCode;
    }

    public static async Task<string> Capture(string file, IEnumerable<string> args, string workDir, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo(file)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args)
            psi.ArgumentList.Add(a);
        using var proc = Process.Start(psi) ?? throw new Exception($"Could not start {file}");
        var output = await proc.StandardOutput.ReadToEndAsync(ct);
        await proc.WaitForExitAsync(ct);
        return output;
    }
}
