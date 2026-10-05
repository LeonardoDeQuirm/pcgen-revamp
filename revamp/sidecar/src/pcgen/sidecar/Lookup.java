package pcgen.sidecar;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/** Resolves a name from the client to an engine object, with useful errors. */
final class Lookup
{
	private Lookup()
	{
	}

	/**
	 * Finds the item whose key or display name equals {@code wanted} (ignoring case).
	 * 404 with close matches if there is none; 409 if several match.
	 */
	static <T> T find(Iterable<T> items, String wanted, String kind, Function<T, String> key,
		Function<T, String> display)
	{
		return find(items, wanted, kind, key, display, null);
	}

	/**
	 * As above. {@code twin}, when given, describes an item well enough that two items with the same description are
	 * interchangeable (a book can define the same item twice): the first of them is taken instead of a 409.
	 */
	static <T> T find(Iterable<T> items, String wanted, String kind, Function<T, String> key,
		Function<T, String> display, Function<T, String> twin)
	{
		List<T> exact = new ArrayList<>();
		List<String> near = new ArrayList<>();
		String w = wanted.trim();
		for (T item : items)
		{
			String k = key.apply(item);
			String d = display.apply(item);
			if (w.equalsIgnoreCase(k) || w.equalsIgnoreCase(d))
			{
				exact.add(item);
			}
			else if (near.size() < 5 && (k.toLowerCase().contains(w.toLowerCase())
					|| d.toLowerCase().contains(w.toLowerCase())))
			{
				near.add(d);
			}
		}
		if (exact.size() == 1)
		{
			return exact.get(0);
		}
		if (exact.size() > 1)
		{
			// Several items can share a display name; the key name is unique, so prefer it.
			List<T> byKey = exact.stream().filter(i -> w.equalsIgnoreCase(key.apply(i))).toList();
			if (byKey.size() == 1)
			{
				return byKey.get(0);
			}
			if (twin != null && exact.stream().map(twin).distinct().count() == 1)
			{
				return exact.get(0);
			}
			throw new ApiException(409, "several " + kind + " items match '" + wanted + "'; use one of these keys: "
					+ exact.stream().limit(8).map(key).collect(java.util.stream.Collectors.joining(", ")));
		}
		throw new ApiException(404, "no " + kind + " named '" + wanted + "'"
				+ (near.isEmpty() ? "" : "; did you mean: " + String.join(", ", near)));
	}

	/** For PCGen objects that have both a key name and a display name. */
	static <T extends pcgen.cdom.base.CDOMObject> T pObject(Iterable<T> items, String wanted, String kind)
	{
		return find(items, wanted, kind, T::getKeyName, T::getDisplayName);
	}
}
