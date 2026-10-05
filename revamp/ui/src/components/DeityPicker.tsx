import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { Picker } from './Picker'

const ALIGNMENT: Record<string, string> = {
  LG: 'Lawful good',
  NG: 'Neutral good',
  CG: 'Chaotic good',
  LN: 'Lawful neutral',
  TN: 'True neutral',
  N: 'Neutral',
  CN: 'Chaotic neutral',
  LE: 'Lawful evil',
  NE: 'Neutral evil',
  CE: 'Chaotic evil',
}

/**
 * Choose the character's deity. The list is the gods in the loaded source books; a search also looks at each god's
 * domains, portfolio and pantheon ("fire", "travel", "healing"), and "None" clears the choice.
 */
export function DeityPicker({ character, onClose }: { character: Character; onClose: () => void }) {
  const { mutate, health } = useStore()
  const id = encodeURIComponent(character.id)
  const books = health?.sources.length ?? 0
  return (
    <Picker
      title="Choose a deity"
      subtitle={`Search by name, domain or portfolio. Only gods from the ${books} loaded source books are listed; a god from another book needs that book loaded.`}
      path="/dataset/deities"
      previewKind="deity"
      qualifyFilter
      describe={(it) => {
        const al = (it as { alignment?: string | null }).alignment
        return al ? (ALIGNMENT[al] ?? al) : undefined
      }}
      onClose={onClose}
      onPick={(it) => void mutate(() => api.patch<Changed>(`/characters/${id}`, { deity: it.key ?? it.name }))}
    />
  )
}
