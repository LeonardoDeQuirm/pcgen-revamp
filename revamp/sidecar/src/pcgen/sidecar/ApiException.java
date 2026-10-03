package pcgen.sidecar;

/** Thrown by handlers for client-visible errors; carries the HTTP status. */
final class ApiException extends RuntimeException
{
	final int status;

	ApiException(int status, String message)
	{
		super(message);
		this.status = status;
	}
}
