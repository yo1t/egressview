namespace EgressView.Agent.Core;

/// Reads the value types a country database uses, and refuses the rest.
///
/// MaxMind DB stores a small tagged format: a control byte carries the type in
/// its top three bits and the length in the bottom five, with escapes for both.
/// Only what a country lookup needs is implemented -- maps, strings, unsigned
/// integers and pointers. A type outside that set returns null rather than a
/// guess, because a value this reader does not understand is not a value it
/// should pretend to have read.
internal sealed class MaxMindDecoder(byte[] bytes, int sectionStart)
{
    private const int TypePointer = 1;
    private const int TypeString = 2;
    private const int TypeUint16 = 5;
    private const int TypeUint32 = 6;
    private const int TypeMap = 7;
    private const int TypeUint64 = 9;

    /// Reads `country.iso_code` and nothing else.
    ///
    /// Walking the whole record would mean decoding every field of every
    /// answer, including the ones a country lookup has no use for.
    internal string? ReadCountryIsoCode(int offset)
    {
        if (ReadMap(offset) is not { } record) return null;
        if (!record.TryGetValue("country", out var country)) return null;
        if (country is not Dictionary<string, object> fields) return null;
        return fields.TryGetValue("iso_code", out var code) && code is string text && text.Length > 0 ? text : null;
    }

    internal Dictionary<string, object>? ReadMap(int offset) => Read(offset, out _) as Dictionary<string, object>;

    private object? Read(int offset, out int next)
    {
        next = offset;
        if (offset < 0 || offset >= bytes.Length) return null;
        var control = bytes[offset];
        var type = control >> 5;
        var length = control & 0x1F;
        var cursor = offset + 1;

        if (type == 0)
        {
            // Extended type: the next byte carries the real type, offset by
            // seven so the extension can never collide with a basic one.
            if (cursor >= bytes.Length) return null;
            type = bytes[cursor] + 7;
            cursor++;
        }

        if (type == TypePointer) return ReadPointer(control, cursor, out next);

        length = ReadLength(length, ref cursor);
        if (length < 0 || cursor + length > bytes.Length) { next = bytes.Length; return null; }

        switch (type)
        {
            case TypeString:
                next = cursor + length;
                return System.Text.Encoding.UTF8.GetString(bytes, cursor, length);
            case TypeUint16:
            case TypeUint32:
            case TypeUint64:
                next = cursor + length;
                return ReadUnsigned(cursor, length);
            case TypeMap:
                return ReadPairs(length, cursor, out next);
            default:
                // Skipped rather than decoded: a country lookup never needs it,
                // and the cursor still has to land in the right place.
                next = cursor + length;
                return null;
        }
    }

    private object? ReadPointer(byte control, int cursor, out int next)
    {
        var size = (control >> 3) & 0x03;
        var value = control & 0x07;
        var needed = size + 1;
        if (cursor + needed > bytes.Length) { next = bytes.Length; return null; }
        var pointer = 0;
        for (var index = 0; index < needed; index++) pointer = (pointer << 8) | bytes[cursor + index];
        // The specification folds the high bits into the control byte for the
        // three shorter forms, and adds a constant so the ranges do not overlap.
        pointer = size switch
        {
            0 => (value << 8) | pointer,
            1 => ((value << 16) | pointer) + 2048,
            2 => ((value << 24) | pointer) + 526_336,
            _ => pointer,
        };
        next = cursor + needed;
        return Read(sectionStart + pointer, out _);
    }

    private int ReadLength(int length, ref int cursor)
    {
        // 29, 30 and 31 mean "the length follows", in one, two or three bytes,
        // each with the previous form's maximum added back on.
        switch (length)
        {
            case 29:
                if (cursor >= bytes.Length) return -1;
                return 29 + bytes[cursor++];
            case 30:
                if (cursor + 2 > bytes.Length) return -1;
                var two = (bytes[cursor] << 8) | bytes[cursor + 1];
                cursor += 2;
                return 285 + two;
            case 31:
                if (cursor + 3 > bytes.Length) return -1;
                var three = (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2];
                cursor += 3;
                return 65_821 + three;
            default:
                return length;
        }
    }

    private ulong ReadUnsigned(int offset, int length)
    {
        var value = 0UL;
        for (var index = 0; index < length; index++) value = (value << 8) | bytes[offset + index];
        return value;
    }

    private Dictionary<string, object>? ReadPairs(int pairs, int cursor, out int next)
    {
        var map = new Dictionary<string, object>(StringComparer.Ordinal);
        for (var index = 0; index < pairs; index++)
        {
            var key = Read(cursor, out cursor);
            var value = Read(cursor, out cursor);
            if (key is string name && value is not null) map[name] = value;
        }
        next = cursor;
        return map;
    }
}
