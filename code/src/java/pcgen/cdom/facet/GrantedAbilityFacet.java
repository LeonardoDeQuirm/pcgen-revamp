/*
 * Copyright (c) Thomas Parker, 2010.
 * 
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU Lesser General Public License as published by the Free
 * Software Foundation; either version 2.1 of the License, or (at your option)
 * any later version.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more
 * details.
 * 
 * You should have received a copy of the GNU Lesser General Public License
 * along with this library; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA
 */
package pcgen.cdom.facet;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

import pcgen.cdom.base.Category;
import pcgen.cdom.base.SetFacet;
import pcgen.cdom.content.CNAbility;
import pcgen.cdom.enumeration.CharID;
import pcgen.cdom.enumeration.Nature;
import pcgen.cdom.enumeration.ObjectKey;
import pcgen.cdom.facet.base.AbstractCNASEnforcingFacet;
import pcgen.cdom.helper.CNAbilitySelection;
import pcgen.core.Ability;
import pcgen.core.AbilityCategory;
import pcgen.output.publish.OutputDB;
import pcgen.util.Logging;
import pcgen.util.enumeration.View;

/**
 * A GrantedAbilityFacet is a DataFacet that contains information about Ability
 * objects that are contained in a Player Character,
 * 
 */
public class GrantedAbilityFacet extends AbstractCNASEnforcingFacet implements SetFacet<CharID, CNAbilitySelection>
{

	/**
	 * The abilities of one character grouped by category, in their original order. Every PREABILITY test asks
	 * for the abilities of one category, and answering by scanning all of a character's abilities each time was
	 * over 90% of the time an edit took on a character with many abilities. Valid while the contents' change
	 * count is unchanged.
	 */
	private static final class PoolIndex
	{
		final long stamp;
		final Map<Category<Ability>, List<CNAbility>> byCategory = new HashMap<>();

		PoolIndex(long stamp)
		{
			this.stamp = stamp;
		}
	}

	private final WeakHashMap<CharID, PoolIndex> poolIndexes = new WeakHashMap<>();

	private synchronized List<CNAbility> inPool(CharID id, Category<Ability> cat)
	{
		long stamp = changeCount(id);
		PoolIndex index = poolIndexes.get(id);
		if (index == null || index.stamp != stamp)
		{
			index = new PoolIndex(stamp);
			List<List<SourcedCNAS>> list = getList(id);
			if (list != null)
			{
				for (List<SourcedCNAS> array : list)
				{
					CNAbility cna = array.get(0).cnas.getCNAbility();
					index.byCategory.computeIfAbsent(cna.getAbilityCategory(), k -> new ArrayList<>()).add(cna);
				}
			}
			poolIndexes.put(id, index);
		}
		List<CNAbility> found = index.byCategory.get(cat);
		return found == null ? Collections.emptyList() : found;
	}

	public boolean hasAbilityVisibleTo(CharID id, Category<Ability> cat, View view)
	{
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			for (List<SourcedCNAS> array : list)
			{
				CNAbility cna = array.get(0).cnas.getCNAbility();
				Ability a = cna.getAbility();
				if (cna.getAbilityCategory().equals(cat) && a.getSafe(ObjectKey.VISIBILITY).isVisibleTo(view))
				{
					return true;
				}
			}
		}
		return false;
	}

	public Collection<CNAbility> getPoolAbilities(CharID id, Category<Ability> cat)
	{
		// A copy, as before: callers are free to change what they get back.
		return new ArrayList<>(inPool(id, cat));
	}

	public Collection<CNAbility> getPoolAbilities(CharID id, Category<Ability> cat, Nature n)
	{
		List<CNAbility> returnList = new ArrayList<>();
		for (CNAbility cna : inPool(id, cat))
		{
			if (cna.getNature() == n)
			{
				returnList.add(cna);
			}
		}
		return returnList;
	}

	public Collection<CNAbility> getCNAbilities(CharID id, Category<Ability> cat)
	{
		if (cat.getParentCategory() != cat)
		{
			Logging.log(Logging.WARNING, "Parent category: " + cat.getParentCategory().getKeyName() + " did not equal category " + cat.getKeyName());
		}

		List<CNAbility> returnList = new ArrayList<>();
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			for (List<SourcedCNAS> array : list)
			{
				CNAbility cna = array.get(0).cnas.getCNAbility();
				if (cna.getAbilityCategory().getParentCategory().equals(cat))
				{
					returnList.add(cna);
				}
			}
		}
		return returnList;
	}

	public Collection<CNAbility> getCNAbilities(CharID id)
	{
		List<CNAbility> returnList = new ArrayList<>();
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			for (List<SourcedCNAS> array : list)
			{
				returnList.add(array.get(0).cnas.getCNAbility());
			}
		}
		return returnList;
	}

	public Collection<CNAbility> getCNAbilities(CharID id, Category<Ability> cat, Nature n)
	{
		List<CNAbility> returnList = new ArrayList<>();
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			for (List<SourcedCNAS> array : list)
			{
				CNAbility cna = array.get(0).cnas.getCNAbility();
				if (cna.getAbilityCategory().getParentCategory().equals(cat) && cna.getNature() == n)
				{
					returnList.add(cna);
				}
			}
		}
		return returnList;
	}

	public Collection<CNAbility> getCNAbilities(CharID id, Ability ability)
	{
		Set<CNAbility> returnList = new HashSet<>();
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			Category<Ability> cat = ability.getCDOMCategory();
			for (List<SourcedCNAS> array : list)
			{
				CNAbility cna = array.get(0).cnas.getCNAbility();
				if (cna.getAbilityCategory().getParentCategory().equals(cat)
					&& cna.getAbilityKey().equals(ability.getKeyName()))
				{
					returnList.add(cna);
				}
			}
		}
		return returnList;
	}

	public boolean hasAbilityKeyed(CharID id, Category<Ability> cat, String aKey)
	{
		List<List<SourcedCNAS>> list = getList(id);
		if (list != null)
		{
			for (List<SourcedCNAS> array : list)
			{
				CNAbility cna = array.get(0).cnas.getCNAbility();
				if (cna.getAbilityCategory().getParentCategory().equals(cat) && cna.getAbilityKey().equals(aKey))
				{
					return true;
				}
			}
		}
		return false;
	}

	public boolean hasAbilityInPool(CharID id, AbilityCategory cat)
	{
		return !inPool(id, cat).isEmpty();
	}

	public void init()
	{
		OutputDB.register("abilities", this);
	}
}
