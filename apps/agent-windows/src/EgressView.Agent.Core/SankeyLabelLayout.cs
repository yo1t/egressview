namespace EgressView.Agent.Core;

/// <summary>Pure layout decisions shared by the rendered Sankey and its tests.</summary>
public static class SankeyLabelLayout
{
    public static int NamedCapacity(double height, double lineHeight)
    {
        if (!double.IsFinite(height) || !double.IsFinite(lineHeight) || height <= 0 || lineHeight <= 0) return 1;
        // Keep one row available for the explicit folded remainder. If there
        // is no remainder the caller can still use the spare breathing room.
        return Math.Max(1, (int)Math.Floor(height / lineHeight) - 1);
    }

    public static IReadOnlyList<string> FitDistinct(
        IReadOnlyList<string> values,
        IReadOnlyList<double> maxWidths,
        Func<string, double> measure)
    {
        ArgumentNullException.ThrowIfNull(values);
        ArgumentNullException.ThrowIfNull(maxWidths);
        ArgumentNullException.ThrowIfNull(measure);
        if (values.Count != maxWidths.Count) throw new ArgumentException("Each label needs a width.", nameof(maxWidths));

        var result = new string[values.Count];
        for (var index = 0; index < values.Count; index++)
        {
            var value = values[index] ?? string.Empty;
            var width = Math.Max(0, maxWidths[index]);
            if (measure(value) <= width)
            {
                result[index] = value;
                continue;
            }

            var prefixRequired = 1;
            var suffixRequired = 1;
            for (var otherIndex = 0; otherIndex < values.Count; otherIndex++)
            {
                if (otherIndex == index || string.Equals(value, values[otherIndex], StringComparison.Ordinal)) continue;
                prefixRequired = Math.Max(prefixRequired, CommonPrefix(value, values[otherIndex] ?? string.Empty) + 1);
                suffixRequired = Math.Max(suffixRequired, CommonSuffix(value, values[otherIndex] ?? string.Empty) + 1);
            }
            prefixRequired = Math.Min(prefixRequired, value.Length);
            suffixRequired = Math.Min(suffixRequired, value.Length);

            var prefixSeed = value[..prefixRequired] + "…";
            var suffixSeed = "…" + value[^suffixRequired..];
            var prefixFits = measure(prefixSeed) <= width;
            var suffixFits = measure(suffixSeed) <= width;
            if (prefixFits && (!suffixFits || measure(prefixSeed) <= measure(suffixSeed)))
                result[index] = ExtendPrefix(value, prefixRequired, width, measure);
            else if (suffixFits)
                result[index] = ExtendSuffix(value, suffixRequired, width, measure);
            else
                result[index] = IdentityFallback(index, width, measure);
        }
        return result;
    }

    private static string ExtendPrefix(string value, int required, double width, Func<string, double> measure)
    {
        var best = value[..required] + "…";
        for (var length = required + 1; length < value.Length; length++)
        {
            var candidate = value[..length] + "…";
            if (measure(candidate) > width) break;
            best = candidate;
        }
        return best;
    }

    private static string ExtendSuffix(string value, int required, double width, Func<string, double> measure)
    {
        var best = "…" + value[^required..];
        for (var length = required + 1; length < value.Length; length++)
        {
            var candidate = "…" + value[^length..];
            if (measure(candidate) > width) break;
            best = candidate;
        }
        return best;
    }

    private static string IdentityFallback(int index, double width, Func<string, double> measure)
    {
        var candidate = $"…{index + 1}";
        if (measure(candidate) <= width) return candidate;
        candidate = (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return measure(candidate) <= width ? candidate : "…";
    }

    private static int CommonPrefix(string left, string right)
    {
        var limit = Math.Min(left.Length, right.Length);
        var index = 0;
        while (index < limit && left[index] == right[index]) index++;
        return index;
    }

    private static int CommonSuffix(string left, string right)
    {
        var limit = Math.Min(left.Length, right.Length);
        var count = 0;
        while (count < limit && left[^(count + 1)] == right[^(count + 1)]) count++;
        return count;
    }
}
