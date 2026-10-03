/*
 * Copyright (c) Thomas Parker, 2018.
 * 
 * This program is free software; you can redistribute it and/or modify it under the terms
 * of the GNU Lesser General Public License as published by the Free Software Foundation;
 * either version 2.1 of the License, or (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details.
 * 
 * You should have received a copy of the GNU Lesser General Public License along with
 * this library; if not, write to the Free Software Foundation, Inc., 51 Franklin Street,
 * Fifth Floor, Boston, MA 02110-1301, USA
 */
package pcgen.cdom.formula;

import java.util.HashMap;
import java.util.Map;

import pcgen.base.formula.base.VarScoped;
import pcgen.base.formula.base.VariableID;
import pcgen.cdom.enumeration.CharID;
import pcgen.cdom.facet.FacetLibrary;
import pcgen.cdom.facet.SolverManagerFacet;
import pcgen.cdom.facet.VariableStoreFacet;
import pcgen.output.channel.ChannelUtilities;

/**
 * A VariableChannelFactoryInst is a VariableChannelFactory that will ensure that a
 * VariableChannel is only produced once per VariableID.
 */
public class VariableChannelFactoryInst implements VariableChannelFactory
{
	/**
	 * The SolverManagerFacet for VariableID construction.
	 */
	private static final SolverManagerFacet MGR_FACET = FacetLibrary.getFacet(SolverManagerFacet.class);

	/**
	 * The VariableStoreFacet for VariableID construction.
	 */
	private static final VariableStoreFacet RESULT_FACET = FacetLibrary.getFacet(VariableStoreFacet.class);

	/**
	 * The VariableChannel objects produced by this VariableChannelFactoryInst.
	 */
	private final Map<VariableChannelKey, VariableChannel<?>> channels = new HashMap<>();

	/**
	 * Identifies one variable on one character. A VariableID alone is not enough: global variables
	 * have the same VariableID for every character using the data set, so caching on it alone hands
	 * every character the first character's VariableChannel (and therefore its values).
	 */
	private record VariableChannelKey(CharID id, VariableID<?> variableID)
	{
	}

	@Override
	public VariableChannel<?> getChannel(CharID id, VarScoped owner, String name)
	{
		String varName = ChannelUtilities.createVarName(name);
		return getChannel(id, VariableUtilities.getLocalVariableID(id, owner, varName));
	}

	@Override
	public VariableChannel<?> getGlobalChannel(CharID id, String name)
	{
		String varName = ChannelUtilities.createVarName(name);
		return getChannel(id, VariableUtilities.getGlobalVariableID(id, varName));
	}

	@Override
	public void disconnect(VariableChannel<?> variableChannel)
	{
		channels.values().remove(variableChannel);
		variableChannel.disconnect();
	}

	/**
	 * Gets a VariableChannel linked to the given VariableID on the PlayerCharacter
	 * represented by the given CharID.
	 * 
	 * As a note on object cleanup: The returned VariableChannel is a listener to the
	 * given MonitorableVariableStore. Should use of this VariableChannel be no longer
	 * necessary, then the disconnect() method should be called in order to disconnect the
	 * VariableChannel from the WriteableVariableStore.
	 * 
	 * @param id
	 *            The CharID representing the PlayerCharacter for which a VariableChannel
	 *            should be returned
	 * @param varID
	 *            The VariableID indicating to which Variable this VariableChannel is
	 *            providing an interface
	 * @return A VariableChannel linked to the given VariableID on the PlayerCharacter
	 *         represented by the given CharID
	 */
	private <T> VariableChannel<T> getChannel(CharID id, VariableID<T> varID)
	{
		@SuppressWarnings("unchecked")
		VariableChannel<T> ref = (VariableChannel<T>) channels.get(new VariableChannelKey(id, varID));
		if (ref == null)
		{
			MonitorableVariableStore varStore = RESULT_FACET.get(id);
			ref = VariableChannel.construct(MGR_FACET.get(id), varStore, varID);
			channels.put(new VariableChannelKey(id, varID), ref);
		}
		return ref;
	}

}
