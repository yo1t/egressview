using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

internal static partial class WinSqlite
{
    internal const int Ok = 0;
    internal const int Row = 100;
    internal const int Done = 101;
    internal const int Corrupt = 11;
    internal const int Full = 13;
    internal const int NotADatabase = 26;
    internal const int OpenReadWrite = 0x00000002;
    internal const int OpenCreate = 0x00000004;
    internal const int OpenFullMutex = 0x00010000;

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_open_v2", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int Open(string filename, out nint db, int flags, nint vfs);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_close_v2")]
    internal static partial int Close(nint db);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_exec", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int Exec(nint db, string sql, nint callback, nint arg, out nint errorMessage);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_free")]
    internal static partial void Free(nint value);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_errmsg")]
    internal static partial nint ErrorMessage(nint db);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_extended_errcode")]
    internal static partial int ExtendedErrorCode(nint db);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_prepare_v2", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int Prepare(nint db, string sql, int bytes, out nint statement, nint tail);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_step")]
    internal static partial int Step(nint statement);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_finalize")]
    internal static partial int Finalize(nint statement);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_reset")]
    internal static partial int Reset(nint statement);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_clear_bindings")]
    internal static partial int ClearBindings(nint statement);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_bind_int64")]
    internal static partial int BindInt64(nint statement, int index, long value);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_bind_null")]
    internal static partial int BindNull(nint statement, int index);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_bind_text", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int BindText(nint statement, int index, string value, int bytes, nint destructor);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_column_int64")]
    internal static partial long ColumnInt64(nint statement, int index);

    [LibraryImport("winsqlite3", EntryPoint = "sqlite3_column_text")]
    internal static partial nint ColumnText(nint statement, int index);
}
