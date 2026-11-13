// SS14 Replay Tools: a small local web app. It runs on your PC, opens its page in your browser
// (http://127.0.0.1 only), builds the exact game version a replay was recorded on, and runs the
// replay tools (split into short replays, export grids at any time) headless.

using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Json;
using SS14ReplayTools;

var noBrowser = args.Contains("--no-browser");
var port = 5114;
for (var i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--port" && int.TryParse(args[i + 1], out var p))
        port = p;
}
if (!PortFree(port))
    port = FreePort();

var dataDir = Environment.GetEnvironmentVariable("SS14_REPLAY_TOOLS_DATA")
              ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SS14ReplayTools");
var store = new BuildStore(dataDir);
var jobs = new JobRunner(store);
var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "?";

var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = Array.Empty<string>() });
builder.WebHost.ConfigureKestrel(o => o.Listen(IPAddress.Loopback, port));
builder.Logging.ClearProviders();
builder.Services.Configure<JsonOptions>(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.TypeInfoResolverChain.Insert(0, new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver());
});
var app = builder.Build();

// Only answer requests addressed to this machine (blocks DNS-rebinding), and require the per-run
// token on every API call so other web pages can't drive the app.
app.Use(async (ctx, next) =>
{
    var host = ctx.Request.Host.Host;
    if (host != "127.0.0.1" && host != "localhost")
    {
        ctx.Response.StatusCode = 403;
        return;
    }
    if (ctx.Request.Path.StartsWithSegments("/api") && ctx.Request.Headers["X-Token"] != token)
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsync("bad token");
        return;
    }
    await next();
});

app.MapGet("/", () =>
{
    using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("index.html")!;
    using var r = new StreamReader(s);
    var html = r.ReadToEnd().Replace("__TOKEN__", token).Replace("__VERSION__", version);
    return Results.Content(html, "text/html; charset=utf-8");
});

// ------------------------------------------------------------------ environment

app.MapGet("/api/status", async () =>
{
    string? git = null;
    var sdks = new List<string>();
    try
    {
        git = (await JobRunner.Capture("git", new[] { "--version" }, dataDir)).Trim();
    }
    catch
    {
        // not installed
    }
    try
    {
        var list = await JobRunner.Capture("dotnet", new[] { "--list-sdks" }, dataDir);
        sdks = list.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Split(' ')[0].Trim()).ToList();
    }
    catch
    {
        // not installed
    }
    return Results.Json(new { version, dataDir, git, dotnetSdks = sdks, os = Environment.OSVersion.Platform.ToString() });
});

// ------------------------------------------------------------------ browsing for replays

app.MapGet("/api/browse", (string? dir) =>
{
    if (string.IsNullOrWhiteSpace(dir))
    {
        var places = new List<object>();
        void Add(string label, string? path)
        {
            if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
                places.Add(new { label, path });
        }
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Add("Last folder", store.LoadSettings().LastDir);
        Add("SS14 replays", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Space Station 14", "data", "replays"));
        Add("SS14 replays", Path.Combine(home, ".local", "share", "Space Station 14", "data", "replays"));
        Add("Downloads", Path.Combine(home, "Downloads"));
        Add("Desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        Add("Home", home);
        foreach (var d in DriveInfo.GetDrives().Where(d => d.IsReady && d.DriveType is DriveType.Fixed or DriveType.Removable))
            Add(d.Name, d.RootDirectory.FullName);
        return Results.Json(new { places });
    }

    try
    {
        var info = new DirectoryInfo(dir);
        var opts = new EnumerationOptions { IgnoreInaccessible = true };
        var dirs = info.EnumerateDirectories("*", opts)
            .Where(d => !d.Name.StartsWith('.'))
            .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
            .Select(d => new { name = d.Name, path = d.FullName })
            .ToList();
        var files = info.EnumerateFiles("*.zip", opts)
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => new { name = f.Name, path = f.FullName, size = f.Length, modified = f.LastWriteTimeUtc })
            .ToList();
        return Results.Json(new { dir = info.FullName, parent = info.Parent?.FullName, dirs, files });
    }
    catch (Exception e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

app.MapPost("/api/replay/info", (PathRequest req) =>
{
    try
    {
        var info = ReplayInfo.Read(req.Path);
        var settings = store.LoadSettings();
        settings.LastDir = Path.GetDirectoryName(Path.GetFullPath(req.Path));
        store.SaveSettings(settings);
        settings.Repos.TryGetValue(info.ForkId, out var repo);
        var buildId = info.CommitIsHash ? BuildStore.MakeId(info.ForkId, info.ForkVersion) : null;
        var build = buildId == null ? null : store.Get(buildId);
        return Results.Json(new
        {
            info,
            commitIsHash = info.CommitIsHash,
            repo,
            buildId,
            buildStatus = build?.Status,
            toolsCurrent = build?.ToolsHash == JobRunner.ToolsHash(),
        });
    }
    catch (Exception e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

app.MapPost("/api/repos", (RepoRequest req) =>
{
    if (!Uri.TryCreate(req.Url, UriKind.Absolute, out var uri) || uri.Scheme != "https")
        return Results.BadRequest(new { error = "Use an https:// git URL, e.g. https://github.com/owner/repo" });
    var settings = store.LoadSettings();
    settings.Repos[req.ForkId] = req.Url.Trim();
    store.SaveSettings(settings);
    return Results.Json(settings.Repos);
});

app.MapGet("/api/repos", () => Results.Json(store.LoadSettings().Repos));

// ------------------------------------------------------------------ builds

app.MapGet("/api/builds", () =>
{
    var list = store.List();
    // Per server, the build with the newest commit date is current; older ones are flagged.
    var newest = list
        .Where(b => b.Status == "ready" && b.CommitDateUtc != null)
        .GroupBy(b => b.ForkId, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.OrderByDescending(b => b.CommitDateUtc).First(), StringComparer.OrdinalIgnoreCase);

    var result = list
        .OrderBy(b => b.ForkId)
        .ThenByDescending(b => b.CommitDateUtc ?? DateTime.MinValue)
        .Select(b =>
        {
            newest.TryGetValue(b.ForkId, out var top);
            var superseded = top != null && top.Id != b.Id && b.CommitDateUtc != null && b.CommitDateUtc < top.CommitDateUtc;
            return new
            {
                build = b,
                inUse = jobs.BuildInUse(b.Id),
                superseded,
                newerId = superseded ? top!.Id : null,
                toolsCurrent = b.ToolsHash == JobRunner.ToolsHash(),
            };
        })
        .ToList();
    return Results.Json(new { builds = result, totalBytes = list.Sum(b => b.SizeBytes ?? 0), dataDir });
});

app.MapDelete("/api/builds/{id}", (string id) =>
{
    if (id.Contains('/') || id.Contains('\\') || id.Contains(".."))
        return Results.BadRequest(new { error = "bad id" });
    if (jobs.BuildInUse(id))
        return Results.BadRequest(new { error = "This build is being used by a running job." });
    try
    {
        store.Delete(id);
        return Results.Ok();
    }
    catch (Exception e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

app.MapPost("/api/builds/{id}/size", (string id) =>
{
    var b = store.Get(id);
    if (b == null)
        return Results.NotFound();
    b.SizeBytes = BuildStore.DirSize(store.BuildDir(id));
    store.Save(b);
    return Results.Json(b);
});

// ------------------------------------------------------------------ jobs

app.MapPost("/api/jobs", (JobRequest req) =>
{
    ReplayInfo info;
    try
    {
        info = ReplayInfo.Read(req.Replay);
    }
    catch (Exception e)
    {
        return Results.BadRequest(new { error = e.Message });
    }

    var commit = string.IsNullOrWhiteSpace(req.Commit) ? info.ForkVersion : req.Commit.Trim();
    if (!System.Text.RegularExpressions.Regex.IsMatch(commit, "^[0-9a-f]{40}$"))
        return Results.BadRequest(new { error = $"The replay's build version '{commit}' is not a git commit hash. Enter the commit the server was running." });

    var settings = store.LoadSettings();
    if (!settings.Repos.TryGetValue(info.ForkId, out var repo))
        return Results.BadRequest(new { error = $"No repository set for server '{info.ForkId}'.", needRepo = info.ForkId });

    var replayName = Path.GetFileNameWithoutExtension(req.Replay);
    var replayDir = Path.GetDirectoryName(Path.GetFullPath(req.Replay))!;
    var seconds = req.Seconds ?? 60;
    var durationSeconds = TimeSpan.TryParse(info.Duration, out var dur) ? dur.TotalSeconds : 0;

    Job job;
    switch (req.Kind)
    {
        case "build":
            job = jobs.Start(new Job { Kind = "build", Title = $"Build {info.ForkId} {commit[..8]}" },
                async j => await jobs.EnsureBuild(j, info.ForkId, repo, commit));
            break;

        case "chunk":
        {
            if (seconds < 5)
                return Results.BadRequest(new { error = "Chunks must be at least 5 seconds." });
            var outDir = string.IsNullOrWhiteSpace(req.OutDir) ? Path.Combine(replayDir, $"{replayName}_chunks_{(int) seconds}s") : req.OutDir;
            var expected = durationSeconds > 0 ? (int) Math.Ceiling(durationSeconds / seconds) : (int?) null;
            job = jobs.Start(new Job { Kind = "chunk", Title = $"Split {replayName} into {(int) seconds}s replays", OutDir = outDir },
                async j =>
                {
                    var b = await jobs.EnsureBuild(j, info.ForkId, repo, commit);
                    await jobs.RunTool(j, b, req.Replay, outDir, $"replay_chunk - - {(int) seconds}", expected);
                });
            break;
        }

        case "export":
        {
            var t = Math.Max(0, seconds);
            var stamp = TimeSpan.FromSeconds(t);
            var outDir = string.IsNullOrWhiteSpace(req.OutDir)
                ? Path.Combine(replayDir, $"{replayName}_grids_{(int) stamp.TotalHours:00}h{stamp.Minutes:00}m{stamp.Seconds:00}s")
                : req.OutDir;
            var grid = req.Grid is { } g ? $" {g}" : "";
            var secs = t.ToString(System.Globalization.CultureInfo.InvariantCulture);
            job = jobs.Start(new Job { Kind = "export", Title = $"Export grids of {replayName} at {stamp:hh\\:mm\\:ss}", OutDir = outDir },
                async j =>
                {
                    var b = await jobs.EnsureBuild(j, info.ForkId, repo, commit);
                    await jobs.RunTool(j, b, req.Replay, outDir, $"replay_export_grids - {secs} -{grid}", null);
                });
            break;
        }

        default:
            return Results.BadRequest(new { error = "kind must be build, chunk or export" });
    }

    return Results.Json(job.Summary());
});

app.MapGet("/api/jobs", () => Results.Json(jobs.All().Select(j => j.Summary())));

app.MapGet("/api/jobs/{id}", (string id, int? from) =>
{
    var job = jobs.Get(id);
    if (job == null)
        return Results.NotFound();
    var (total, lines) = job.LinesFrom(from ?? 0);
    return Results.Json(new { job = job.Summary(), total, lines });
});

app.MapPost("/api/jobs/{id}/cancel", (string id) =>
{
    var job = jobs.Get(id);
    if (job == null)
        return Results.NotFound();
    job.Cancel.Cancel();
    return Results.Ok();
});

app.MapPost("/api/open", (PathRequest req) =>
{
    var path = req.Path;
    if (!Directory.Exists(path) && !File.Exists(path))
        return Results.BadRequest(new { error = "Not found" });
    try
    {
        if (OperatingSystem.IsWindows())
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
        else if (OperatingSystem.IsMacOS())
            Process.Start("open", new[] { path });
        else
            Process.Start("xdg-open", new[] { path });
        return Results.Ok();
    }
    catch (Exception e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

var url = $"http://127.0.0.1:{port}/";
Console.WriteLine($"SS14 Replay Tools {version}");
Console.WriteLine($"Open {url} in your browser. Close this window to quit.");
Console.WriteLine($"Builds are stored in {store.BuildsDir}");

if (!noBrowser)
{
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // no browser available; the URL is printed above
        }
    });
}

app.Run();

static bool PortFree(int port)
{
    try
    {
        var l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        l.Stop();
        return true;
    }
    catch
    {
        return false;
    }
}

static int FreePort()
{
    var l = new TcpListener(IPAddress.Loopback, 0);
    l.Start();
    var port = ((IPEndPoint) l.LocalEndpoint).Port;
    l.Stop();
    return port;
}

public sealed record PathRequest(string Path);
public sealed record RepoRequest(string ForkId, string Url);
public sealed record JobRequest(string Kind, string Replay, double? Seconds, int? Grid, string? OutDir, string? Commit);
