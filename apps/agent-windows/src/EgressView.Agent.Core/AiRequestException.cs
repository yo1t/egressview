namespace EgressView.Agent.Core;

/// What went wrong with an AI request, as a kind rather than as a sentence.
///
/// The screen must be able to say what happened in the reader's language, and
/// an exception message cannot do that: it is written once, in English, by
/// whoever threw it. It can also carry an endpoint, a model name or a path,
/// none of which belong on a status line.
///
/// So the failure travels as a kind, and the words are chosen where the
/// language is known.
public enum AiFailureKind
{
    /// The provider did not answer inside the request's own deadline.
    Timeout,
    /// The provider answered, with nothing in it.
    Empty,
    /// The provider refused. Carries the status code, which is the part a
    /// reader can act on: 401 means the key, 429 means wait.
    HttpStatus,
    /// An answer arrived that could not be read as an answer.
    Unreadable,
    /// The answer was larger than the agent will accept.
    TooLarge,
    /// The key is not in a shape a key can be in.
    InvalidKey,
    /// There is no key stored for this provider.
    MissingKey,
    /// A model that is not installed, or not one of the supported ones.
    ModelUnavailable,
    /// The request itself was not acceptable -- too long a question, too large
    /// a context, an endpoint that is not loopback.
    RequestRejected,
}

public sealed class AiRequestException(AiFailureKind kind, string message, int? statusCode = null, Exception? inner = null)
    : Exception(message, inner)
{
    public AiFailureKind Kind { get; } = kind;

    /// Present only for <see cref="AiFailureKind.HttpStatus"/>.
    public int? StatusCode { get; } = statusCode;

    /// The kind for an exception that was not raised as one of these.
    ///
    /// A cancelled request is the caller's own doing and is not a failure, so
    /// it is not classified here; everything else that is not recognised is
    /// reported as unreadable rather than guessed at.
    public static AiFailureKind Classify(Exception exception) => exception switch
    {
        AiRequestException typed => typed.Kind,
        TaskCanceledException or TimeoutException => AiFailureKind.Timeout,
        HttpRequestException => AiFailureKind.HttpStatus,
        System.Text.Json.JsonException => AiFailureKind.Unreadable,
        _ => AiFailureKind.Unreadable,
    };
}
