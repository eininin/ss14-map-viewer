// Replay tools: shared helpers for the replay_chunk and replay_export_grids console commands.
// These files are copied into a fork's Content.Client/_ReplayTools/ folder by the GitHub workflow
// (.github/workflows/replay-tools.yml). They only work with ROBUST_DISABLE_SANDBOX=1, because they
// read and write files outside the game's user-data folder.
//
// Dependencies are resolved with IoCManager.Resolve instead of [Dependency] fields, so the same code
// builds on old engines (readonly fields) and new ones (source-generated injection).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using Robust.Shared.GameStates;
using Robust.Shared.Replays;
using Robust.Shared.Serialization;
using Robust.Shared.Utility;

namespace Content.Client._ReplayTools;

internal static class ReplayToolsCommon
{
    public const string Folder = "_replay/";
    public const string DoneMarker = "REPLAYTOOLS_DONE";
    public const string FailMarker = "REPLAYTOOLS_FAILED";

    /// <summary>
    /// Reads every (state, messages) pair from the replay's data files in tick order, one data file at a
    /// time. Messages are returned untouched (prototype and resource uploads included).
    /// </summary>
    public static IEnumerable<(GameState State, ReplayMessage Messages)> ReadRaw(ZipArchive zip, IRobustSerializer ser)
    {
        var lenBuf = new byte[4];
        for (var i = 0; ; i++)
        {
            var entry = zip.GetEntry($"{Folder}{ReplayConstants.DataFilePrefix}{i}.{ReplayConstants.Ext}");
            if (entry == null)
                yield break;

            MemoryStream ms;
            using (var stream = entry.Open())
            {
                stream.ReadExactly(lenBuf);
                var len = BitConverter.ToInt32(lenBuf);
                using var dz = new ZStdDecompressStream(stream, false);
                ms = new MemoryStream(len);
                dz.CopyTo(ms);
            }

            ms.Position = 0;
            while (ms.Position < ms.Length)
            {
                ser.DeserializeDirect(ms, out GameState state);
                ser.DeserializeDirect(ms, out ReplayMessage msg);
                yield return (state, msg);
            }
        }
    }

    public static ReplayMessage? ReadInit(ZipArchive zip, IRobustSerializer ser)
    {
        var entry = zip.GetEntry(Folder + ReplayConstants.FileInit);
        if (entry == null)
            return null;

        using var stream = entry.Open();
        var ms = new MemoryStream();
        stream.CopyTo(ms);
        ms.Position = 0;
        ser.DeserializeDirect(ms, out ReplayMessage msg);
        return msg;
    }

    public static string ReadText(ZipArchive zip, string name)
    {
        var entry = zip.GetEntry(name) ?? throw new FileNotFoundException($"{name} not found in replay");
        using var reader = new StreamReader(entry.Open());
        return reader.ReadToEnd();
    }

    /// <summary>
    /// A path argument of "-" means: take it from an environment variable. The desktop app passes
    /// paths this way so spaces and backslashes never go through console argument parsing.
    /// </summary>
    public static string PathArg(string arg, string envVar)
    {
        if (arg != "-")
            return arg;
        return Environment.GetEnvironmentVariable(envVar)
               ?? throw new ArgumentException($"Argument is '-' but {envVar} is not set");
    }

    public const string EnvReplay = "REPLAYTOOLS_REPLAY";
    public const string EnvOut = "REPLAYTOOLS_OUT";

    public static bool IsUpload(object msg)
    {
        // ReplayResourceUploadMsg is internal to the engine, so match it by name.
        var name = msg.GetType().Name;
        return name == "ReplayPrototypeUploadMsg" || name == "ReplayResourceUploadMsg";
    }

    /// <summary>
    /// Writes cvars in the TOML layout the engine reads: first name segment is the table.
    /// </summary>
    public static string CvarsToToml(Dictionary<string, object> cvars)
    {
        var tables = new SortedDictionary<string, List<(string Key, object Value)>>(StringComparer.Ordinal);
        foreach (var (name, value) in cvars)
        {
            var dot = name.IndexOf('.');
            var table = dot < 0 ? "" : name[..dot];
            var key = dot < 0 ? name : name[(dot + 1)..];
            if (!tables.TryGetValue(table, out var list))
                tables[table] = list = new();
            list.Add((key, value));
        }

        var sb = new StringBuilder();
        // Keys without a table must come before the first [table] header.
        if (tables.TryGetValue("", out var rootKeys))
        {
            foreach (var (key, value) in rootKeys)
                sb.Append(TomlKey(key)).Append(" = ").Append(TomlValue(value)).Append('\n');
        }

        foreach (var (table, list) in tables)
        {
            if (table == "")
                continue;
            sb.Append('[').Append(TomlKey(table)).Append("]\n");
            list.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
            foreach (var (key, value) in list)
                sb.Append(TomlKey(key)).Append(" = ").Append(TomlValue(value)).Append('\n');
            sb.Append('\n');
        }

        return sb.ToString();
    }

    private static string TomlKey(string key)
    {
        // Dotted keys are fine in TOML and read back as the same joined cvar name. Quote anything unusual.
        foreach (var part in key.Split('.'))
        {
            foreach (var c in part)
            {
                if (!(char.IsAsciiLetterOrDigit(c) || c == '_' || c == '-'))
                    return TomlString(key);
            }
        }
        return key;
    }

    private static string TomlValue(object value)
    {
        switch (value)
        {
            case bool b:
                return b ? "true" : "false";
            case int or long or short or byte or uint or ushort or sbyte:
                return Convert.ToString(value, CultureInfo.InvariantCulture)!;
            case ulong ul:
                return ul.ToString(CultureInfo.InvariantCulture);
            case float or double:
            {
                var d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(d))
                    return "nan";
                if (double.IsPositiveInfinity(d))
                    return "inf";
                if (double.IsNegativeInfinity(d))
                    return "-inf";
                var s = d.ToString("R", CultureInfo.InvariantCulture);
                if (!s.Contains('.') && !s.Contains('E') && !s.Contains('e'))
                    s += ".0";
                return s;
            }
            case Enum e:
                return Convert.ToInt64(e, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            default:
                return TomlString(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "");
        }
    }

    private static string TomlString(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        sb.Append("\\u").Append(((int) c).ToString("X4"));
                    else
                        sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    public static string JsonString(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                default:
                    if (c < 0x20)
                        sb.Append("\\u").Append(((int) c).ToString("X4"));
                    else
                        sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    public static string SafeFileName(string s)
    {
        var sb = new StringBuilder();
        foreach (var c in s)
            sb.Append(char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
        var result = sb.ToString().Trim('_');
        return result.Length == 0 ? "unnamed" : result;
    }
}

/// <summary>
/// Writes one replay zip in the engine's layout: data_N.dat files of ~1 MB uncompressed, each a 4-byte
/// uncompressed length followed by a zstd frame of serialized (GameState, ReplayMessage) pairs.
/// </summary>
internal sealed class ReplayZipWriter : IDisposable
{
    private const int BatchSize = 1024 * 1024;

    private readonly ZipArchive _zip;
    private readonly IRobustSerializer _ser;
    private readonly ZStdCompressionContext _ctx = new();
    private readonly MemoryStream _batch = new();

    public int FileCount { get; private set; }
    public long CompressedSize { get; private set; }
    public long UncompressedSize { get; private set; }

    public ReplayZipWriter(string path, IRobustSerializer ser)
    {
        _zip = new ZipArchive(File.Create(path), ZipArchiveMode.Create);
        _ser = ser;
    }

    public void AddTick(GameState state, ReplayMessage messages)
    {
        _ser.SerializeDirect(_batch, state);
        _ser.SerializeDirect(_batch, messages);
        if (_batch.Length >= BatchSize)
            Flush();
    }

    public void Flush()
    {
        if (_batch.Length == 0)
            return;

        var length = (int) _batch.Length;
        var src = _batch.GetBuffer().AsSpan(0, length);
        var bound = ZStd.CompressBound(length);
        var buf = new byte[4 + bound];
        var compressed = _ctx.Compress2(buf.AsSpan(4, bound), src);
        BitConverter.TryWriteBytes(buf.AsSpan(0, 4), length);

        var entry = _zip.CreateEntry(
            $"{ReplayToolsCommon.Folder}{ReplayConstants.DataFilePrefix}{FileCount}.{ReplayConstants.Ext}",
            CompressionLevel.NoCompression);
        using (var stream = entry.Open())
            stream.Write(buf, 0, compressed + 4);

        FileCount++;
        CompressedSize += compressed;
        UncompressedSize += length;
        _batch.SetLength(0);
    }

    public void WriteSerialized<T>(string name, T obj)
    {
        var ms = new MemoryStream();
        _ser.SerializeDirect(ms, obj);
        WriteBytes(name, ms.ToArray());
    }

    public void WriteText(string name, string text)
    {
        WriteBytes(name, new UTF8Encoding(false).GetBytes(text));
    }

    public void WriteBytes(string name, byte[] data, CompressionLevel level = CompressionLevel.Optimal)
    {
        var entry = _zip.CreateEntry(name, level);
        using var stream = entry.Open();
        stream.Write(data);
    }

    public void CopyEntry(ZipArchiveEntry source)
    {
        if (source.FullName.EndsWith('/'))
        {
            _zip.CreateEntry(source.FullName);
            return;
        }

        var entry = _zip.CreateEntry(source.FullName, CompressionLevel.Optimal);
        using var from = source.Open();
        using var to = entry.Open();
        from.CopyTo(to);
    }

    public void Dispose()
    {
        Flush();
        _zip.Dispose();
        _ctx.Dispose();
    }
}
