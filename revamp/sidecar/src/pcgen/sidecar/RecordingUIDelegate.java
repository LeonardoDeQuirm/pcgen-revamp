package pcgen.sidecar;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.ChooserFacade;
import pcgen.facade.core.EquipmentBuilderFacade;
import pcgen.facade.core.SpellBuilderFacade;
import pcgen.facade.core.EquipmentBuilderFacade;
import pcgen.facade.core.InfoFacade;
import pcgen.facade.core.UIDelegate;
import pcgen.system.PropertyContext;

/**
 * A no-UI {@link UIDelegate} that records every message the engine raises so the
 * API can hand them to the client, and declines every interactive request.
 * <p>
 * General choosers are bridged to the client: the engine thread blocks inside
 * {@link #showGeneralChooser} until the client answers (or {@link #CHOOSER_TIMEOUT_SECONDS}
 * passes, which cancels). Input/custom-equip/custom-spell dialogs are still declined.
 */
public class RecordingUIDelegate implements UIDelegate
{
	public record Message(String level, String title, String text)
	{
	}

	/**
	 * How long the engine waits for a person to answer a question before giving up on it. This is human think
	 * time, not engine speed, so it is generous; a page that is closed mid-question cancels it on reload anyway.
	 */
	static final long CHOOSER_TIMEOUT_SECONDS = 3600;

	/** Indexes into the chooser's available list to add, and into its already-selected list to remove. */
	record Answer(int[] add, int[] remove)
	{
	}

	/** A yes/no question the engine is waiting on ("Are your abilities set as you'd like them?"). */
	static final class PendingConfirm
	{
		final String id;
		final String title;
		final String message;
		final CompletableFuture<Boolean> answer = new CompletableFuture<>();

		PendingConfirm(String id, String title, String message)
		{
			this.id = id;
			this.title = title;
			this.message = message;
		}
	}

	/** A chooser the engine is waiting on. Created and resolved on different threads. */
	static final class PendingChooser
	{
		final String id;
		final ChooserFacade chooser;
		final CompletableFuture<Answer> answer = new CompletableFuture<>();

		PendingChooser(String id, ChooserFacade chooser)
		{
			this.id = id;
			this.chooser = chooser;
		}
	}

	/** The end of a builder edit that was started with {@link PendingBuilder#startOnEngine}. */
	record EditDone(Object result, Throwable error)
	{
	}

	/** Work for the engine thread, queued by an HTTP thread while the engine is parked in a dialog. */
	private record EngineTask(Callable<Object> body, CompletableFuture<Object> out)
	{
	}

	/**
	 * A custom-equipment session the engine is parked in. While it exists the engine thread runs
	 * queued tasks (so edits happen on the engine thread) until the client commits or cancels.
	 */
	static final class PendingBuilder
	{
		final String id;
		final EquipmentBuilderFacade builder;
		private final BlockingQueue<EngineTask> tasks = new LinkedBlockingQueue<>();
		private volatile CustomEquipResult result;
		/** The running operation's event queue: edits report their end (or a question they ask) there. */
		volatile BlockingQueue<Object> events;

		PendingBuilder(String id, EquipmentBuilderFacade builder)
		{
			this.id = id;
			this.builder = builder;
		}

		/** Run something on the engine thread and wait for it. Call from HTTP threads only. */
		<T> T runOnEngine(Callable<T> body) throws Exception
		{
			CompletableFuture<Object> out = new CompletableFuture<>();
			if (result != null)
			{
				throw new IllegalStateException("builder session already finished");
			}
			tasks.add(new EngineTask(() -> body.call(), out));
			try
			{
				@SuppressWarnings("unchecked")
				T value = (T) out.get(CHOOSER_TIMEOUT_SECONDS, TimeUnit.SECONDS);
				return value;
			}
			catch (java.util.concurrent.ExecutionException e)
			{
				if (e.getCause() instanceof Exception ex)
				{
					throw ex;
				}
				throw e;
			}
		}

		/**
		 * Starts an edit that may ask the person something (adding an enchantment can: "Add Type" asks which types).
		 * Returns at once; the outcome, or the question, comes through the operation's event queue (Sidecar.awaitEvent).
		 */
		void startOnEngine(Callable<Object> body)
		{
			if (result != null)
			{
				throw new IllegalStateException("builder session already finished");
			}
			CompletableFuture<Object> out = new CompletableFuture<>();
			out.whenComplete((v, e) -> events.add(new EditDone(v, e)));
			tasks.add(new EngineTask(body, out));
		}

		/** Ends the session; the engine thread leaves the dialog and carries on. */
		void finish(CustomEquipResult r)
		{
			result = r;
			tasks.add(new EngineTask(() -> null, new CompletableFuture<>()));
		}
	}

	private final List<Message> messages = new ArrayList<>();
	private Supplier<Sidecar.Operation> currentOperation = () -> null;
	private int chooserCounter;
	/**
	 * While set, a question asked again with the same name gets the earlier answer without asking the person twice.
	 * Applying a kit makes the engine ask each of its questions twice (once as a rehearsal on a copy of the
	 * character, once for real).
	 */
	private java.util.Map<String, Answer> replay;

	/** When set, the next chooser is answered by picking the options with these names, without asking anyone. */
	private java.util.Set<String> scriptedChoice;

	/**
	 * Runs {@code action} with the engine's chooser answered from a list of names (case-insensitive, key or display
	 * name). Used when the caller already knows what it wants, such as the metamagic feats to prepare a spell with.
	 */
	void withScriptedChoice(java.util.Collection<String> names, Runnable action)
	{
		scriptedChoice = new java.util.HashSet<>();
		names.forEach(n -> scriptedChoice.add(n.toLowerCase(java.util.Locale.ROOT)));
		try
		{
			action.run();
		}
		finally
		{
			scriptedChoice = null;
		}
	}

	/** Runs {@code action}, answering any question the engine repeats from the first answer. */
	void withRepeatedAnswers(Runnable action)
	{
		replay = new java.util.HashMap<>();
		try
		{
			action.run();
		}
		finally
		{
			replay = null;
		}
	}

	void setCurrentOperation(Supplier<Sidecar.Operation> s)
	{
		currentOperation = s;
	}

	/** Return and clear everything recorded since the last call. */
	public synchronized List<Message> drain()
	{
		List<Message> copy = new ArrayList<>(messages);
		messages.clear();
		return copy;
	}

	private synchronized void record(String level, String title, String text)
	{
		messages.add(new Message(level, title, text));
	}

	/**
	 * Asks the client a yes/no question while the engine waits. With no API operation running there is
	 * nobody to ask, so the answer is {@code ifNobodyToAsk}. Cancelling, or no answer in time, is "no".
	 */
	private boolean confirm(String title, String message, boolean ifNobodyToAsk)
	{
		Sidecar.Operation op = currentOperation.get();
		// A silent (background) operation has nobody to ask, exactly like having no operation at all.
		if (op == null || op.silent)
		{
			record("warning", title, message);
			return ifNobodyToAsk;
		}
		PendingConfirm pending = new PendingConfirm("k" + (++chooserCounter), title, message);
		op.confirm = pending;
		op.events.add(pending);
		try
		{
			return pending.answer.get(CHOOSER_TIMEOUT_SECONDS, TimeUnit.SECONDS);
		}
		catch (Exception e)
		{
			record("warning", title, message + " (no answer; treated as no)");
			return false;
		}
		finally
		{
			op.confirm = null;
		}
	}

	@Override
	public Boolean maybeShowWarningConfirm(String title, String message, String checkBoxText, PropertyContext context,
		String contextProp)
	{
		// The GUI returns null when the user ticked "don't ask again", and the engine treats that as "go ahead".
		// There is no such setting here, so every time is a real question.
		return confirm(title, message, true);
	}

	@Override
	public void showErrorMessage(String title, String message)
	{
		record("error", title, message);
	}

	@Override
	public void showInfoMessage(String title, String message)
	{
		record("info", title, message);
	}

	@Override
	public void showLevelUpInfo(CharacterFacade character, int oldLevel)
	{
		record("info", "level-up", "from level " + oldLevel);
	}

	@Override
	public boolean showWarningConfirm(String title, String message)
	{
		return confirm(title, message, true);
	}

	@Override
	public void showWarningMessage(String title, String message)
	{
		record("warning", title, message);
	}

	@Override
	public boolean showGeneralChooser(ChooserFacade chooser)
	{
		Sidecar.Operation op = currentOperation.get();
		// A silent (background) operation has nobody to ask, exactly like having no operation at all.
		if (op == null || op.silent)
		{
			record("chooser-declined", String.valueOf(chooser.getName()), "no API operation is running");
			return false;
		}
		if (scriptedChoice != null)
		{
			var offered = chooser.getAvailableList();
			List<InfoFacade> wanted = new ArrayList<>();
			for (int i = 0; i < offered.getSize(); i++)
			{
				InfoFacade f = offered.getElementAt(i);
				if (scriptedChoice.contains(String.valueOf(f.getKeyName()).toLowerCase(java.util.Locale.ROOT))
						|| scriptedChoice.contains(String.valueOf(f).toLowerCase(java.util.Locale.ROOT)))
				{
					wanted.add(f);
				}
			}
			wanted.forEach(chooser::addSelected);
			chooser.commit();
			return true;
		}
		Answer picks = null;
		boolean repeated = false;
		String repeatKey = chooser.getName();
		if (replay != null && repeatKey != null && replay.containsKey(repeatKey))
		{
			picks = replay.get(repeatKey);
			repeated = true;
		}
		PendingChooser pending = new PendingChooser("c" + (++chooserCounter), chooser);
		if (!repeated)
		{
			op.pending = pending;
			op.events.add(pending);
		}
		try
		{
			if (!repeated)
			{
				picks = pending.answer.get(CHOOSER_TIMEOUT_SECONDS, TimeUnit.SECONDS);
				if (replay != null && repeatKey != null && picks != null)
				{
					replay.put(repeatKey, picks);
				}
			}
		}
		catch (TimeoutException e)
		{
			record("chooser-timeout", chooser.getName(), "no answer within " + CHOOSER_TIMEOUT_SECONDS + "s");
			picks = null;
		}
		catch (Exception e)
		{
			picks = null;
		}
		finally
		{
			op.pending = null;
		}
		if (picks == null)
		{
			chooser.rollback();
			return false;
		}
		var available = chooser.getAvailableList();
		var selected = chooser.getSelectedList();
		for (int i : picks.add())
		{
			if (i < 0 || i >= available.getSize())
			{
				record("error", chooser.getName(), "select index out of range: " + i);
				chooser.rollback();
				return false;
			}
		}
		for (int i : picks.remove())
		{
			if (i < 0 || i >= selected.getSize())
			{
				record("error", chooser.getName(), "deselect index out of range: " + i);
				chooser.rollback();
				return false;
			}
		}
		// Resolve every index before mutating: both lists change as items move.
		List<InfoFacade> toAdd = new ArrayList<>();
		for (int i : picks.add())
		{
			toAdd.add(available.getElementAt(i));
		}
		List<InfoFacade> toRemove = new ArrayList<>();
		for (int i : picks.remove())
		{
			toRemove.add(selected.getElementAt(i));
		}
		toRemove.forEach(chooser::removeSelected);
		toAdd.forEach(chooser::addSelected);
		if (chooser.isRequireCompleteSelection() && chooser.getRemainingSelections().get() > 0)
		{
			record("error", chooser.getName(),
				"incomplete selection: " + chooser.getRemainingSelections().get() + " more required");
			chooser.rollback();
			return false;
		}
		chooser.commit();
		return true;
	}

	/** What the client sees of a pending chooser. */
	static java.util.Map<String, Object> describe(PendingChooser p)
	{
		ChooserFacade c = p.chooser;
		List<java.util.Map<String, Object>> options = new ArrayList<>();
		int i = 0;
		for (InfoFacade item : c.getAvailableList())
		{
			options.add(java.util.Map.of("index", i++, "name", String.valueOf(item), "key", String.valueOf(item.getKeyName())));
		}
		java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
		m.put("id", p.id);
		m.put("title", c.getName());
		m.put("choicesRequired", c.getRemainingSelections().get());
		m.put("requireCompleteSelection", c.isRequireCompleteSelection());
		m.put("preferSingleSelect", c.isPreferRadioSelection());
		m.put("freeTextInput", c.isUserInput());
		List<java.util.Map<String, Object>> selected = new ArrayList<>();
		int j = 0;
		for (InfoFacade item : c.getSelectedList())
		{
			selected.add(java.util.Map.of("index", j++, "name", String.valueOf(item)));
		}
		m.put("alreadySelected", selected);
		m.put("options", options);
		return m;
	}

	@Override
	public Optional<String> showInputDialog(String title, String message, String initialValue)
	{
		record("input-declined", title, message);
		return Optional.empty();
	}

	@Override
	public CustomEquipResult showCustomEquipDialog(CharacterFacade character, EquipmentBuilderFacade equipBuilder)
	{
		Sidecar.Operation op = currentOperation.get();
		// A silent (background) operation has nobody to ask, exactly like having no operation at all.
		if (op == null || op.silent)
		{
			record("custom-equip-declined", "", "no API operation is running");
			return CustomEquipResult.CANCELLED;
		}
		PendingBuilder pending = new PendingBuilder("b" + (++chooserCounter), equipBuilder);
		op.builder = pending;
		pending.events = op.events;
		op.events.add(pending);
		try
		{
			long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(CHOOSER_TIMEOUT_SECONDS);
			while (pending.result == null)
			{
				long left = deadline - System.nanoTime();
				EngineTask t = left <= 0 ? null : pending.tasks.poll(left, TimeUnit.NANOSECONDS);
				if (t == null)
				{
					record("custom-equip-timeout", "", "no activity within " + CHOOSER_TIMEOUT_SECONDS + "s");
					return CustomEquipResult.CANCELLED;
				}
				try
				{
					t.out().complete(t.body().call());
				}
				catch (Throwable e)
				{
					t.out().completeExceptionally(e);
				}
			}
			return pending.result;
		}
		catch (InterruptedException e)
		{
			Thread.currentThread().interrupt();
			return CustomEquipResult.CANCELLED;
		}
		finally
		{
			op.builder = null;
		}
	}

	@Override
	public boolean showCustomSpellDialog(SpellBuilderFacade spellBuilderFacade)
	{
		record("custom-spell-declined", "", "");
		return false;
	}
}
