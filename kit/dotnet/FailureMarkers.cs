// The Steward's kit, its dotnet part: the accelerators' failure markers (the spec's ACCELERATORS.md, "Shared
// files"), `<id>.failed.json` in a folder, read and written as every program does. When one counts and what
// one says are the core's (KitCore); this file reads, writes and removes the files.

#nullable enable

using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Steward.Kit {
	/// <summary>
	/// Failure markers in a folder: the manor's shared ones (<c>.npu-agent\accelerators</c>, about model servers), or a
	/// program's own (Heiward keeps its own, about its in-process runtimes). Only accelerator ids name a marker.
	/// </summary>
	public static class FailureMarkers {
		/// <summary>The marker's file for an accelerator id.</summary>
		public static string FileOf(string folder, string id) {
			if (!KitCore.Shared.IsId(id)) throw new ArgumentException($"Not an accelerator id: \"{id}\".", nameof(id));
			return Path.Combine(folder, id + ".failed.json");
		}

		/// <summary>Its marker while it counts; null when there is none, it's unreadable (which counts the same), it has expired, or the id isn't one.</summary>
		public static KitFailure? Read(string folder, string id, DateTime? nowUtc = null) {
			if (!KitCore.Shared.IsId(id)) return null;
			return KitCore.Shared.FailureOf(ReadShared(FileOf(folder, id)), nowUtc ?? DateTime.UtcNow);
		}

		/// <summary>Marks it failed now: <c>{ "since", "reason", "by" }</c>, the reason's first line, written whole. Throws when it can't be written.</summary>
		public static void Mark(string folder, string id, string? reason, string by, DateTime? nowUtc = null) =>
			WriteWhole(FileOf(folder, id), KitCore.Shared.FailureText(reason, by, nowUtc ?? DateTime.UtcNow));

		/// <summary>A success on it: its marker goes. True when there was one to remove.</summary>
		public static bool Clear(string folder, string id) {
			if (!KitCore.Shared.IsId(id)) return false;
			string file = FileOf(folder, id);
			try {
				if (!File.Exists(file)) return false;
				File.Delete(file);
				return true;
			}
			catch (Exception e) when (e is IOException or UnauthorizedAccessException) {
				return false;
			}
		}

		/// <summary>A file's text, read sharing read, write and delete (a writer renames over it, a success deletes it); null when it's absent or unreadable.</summary>
		public static string? ReadShared(string path) {
			try {
				using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
				using var reader = new StreamReader(file, new UTF8Encoding(false));
				return reader.ReadToEnd();
			}
			catch (Exception e) when (e is IOException or UnauthorizedAccessException) {
				return null;
			}
		}

		/// <summary>Written whole: a temporary file beside it, then a rename over it, so a reader never sees half of it. Windows refuses the rename for a moment while a reader has it open: tried again briefly.</summary>
		public static void WriteWhole(string path, string text) => WriteWhole(path, new UTF8Encoding(false).GetBytes(text));

		/// <inheritdoc cref="WriteWhole(string, string)"/>
		public static void WriteWhole(string path, byte[] contents) {
			Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
			string tmp = $"{path}.{Environment.ProcessId}.{Guid.NewGuid().ToString("N")[..6]}.tmp";
			File.WriteAllBytes(tmp, contents);
			for (int attempt = 0; ; attempt++) {
				try {
					File.Move(tmp, path, overwrite: true);
					return;
				}
				catch (Exception e) when (e is IOException or UnauthorizedAccessException && attempt < 5) {
					Thread.Sleep(20 * (attempt + 1));
				}
				catch {
					try { File.Delete(tmp); } catch { }
					throw;
				}
			}
		}
	}
}
