package pcgen.sidecar;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A minimal folder browser so a browser-based UI (which cannot see real file paths) can pick a
 * character file. Lists sub-folders and {@code .pcg} files only. Loopback-only like everything else.
 */
final class FileRoutes
{
	void register(Router r)
	{
		r.get("/files", this::list);
	}

	private Object list(Request q)
	{
		File dir = q.has("dir") && !q.requireStr("dir").isBlank()
				? new File(q.requireStr("dir")) : new File(System.getProperty("user.home"));
		dir = dir.getAbsoluteFile();
		if (!dir.isDirectory())
		{
			throw new ApiException(404, "not a folder: " + dir);
		}
		File[] children = dir.listFiles();
		List<Map<String, Object>> entries = new ArrayList<>();
		if (children != null)
		{
			Arrays.sort(children, Comparator.comparing((File f) -> !f.isDirectory())
					.thenComparing(f -> f.getName().toLowerCase(Locale.ROOT)));
			for (File f : children)
			{
				boolean isDir = f.isDirectory();
				if (f.isHidden() || f.getName().startsWith(".")
						|| (!isDir && !f.getName().toLowerCase(Locale.ROOT).endsWith(".pcg")))
				{
					continue;
				}
				Map<String, Object> e = new LinkedHashMap<>();
				e.put("name", f.getName());
				e.put("type", isDir ? "dir" : "pcg");
				e.put("path", f.getPath());
				if (!isDir)
				{
					e.put("size", f.length());
					e.put("modified", f.lastModified());
				}
				entries.add(e);
			}
		}
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("dir", dir.getPath());
		m.put("parent", dir.getParent());
		m.put("home", System.getProperty("user.home"));
		List<String> roots = new ArrayList<>();
		for (File root : File.listRoots())
		{
			roots.add(root.getPath());
		}
		m.put("roots", roots);
		m.put("entries", entries);
		return m;
	}
}
