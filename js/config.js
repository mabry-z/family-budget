export const SUPABASE_URL = 'https://ffjaqdtdoqkvlrcfqnrx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lwdziY_FYlVNYoTh-Z2oTw_3SoDNDNr';

// `value` is what's stored in expenses.card, so existing rows keep matching.
// The database only accepts values listed in the expenses_card_check
// constraint (see supabase/migrations/002_allow_usaa_other_cards.sql);
// adding a card here means updating that constraint too.
export const CARDS = [
  { value: 'Chase',     label: 'Chase', badge: 'CH', color: '#1B3A6B' },
  { value: 'AMEX',      label: 'AMEX',  badge: 'AX', color: '#0E8C86' },
  { value: 'Star Card', label: 'Star',  badge: 'SC', color: '#C9972F' },
  { value: 'USAA',      label: 'USAA',  badge: 'U',  color: '#1E3A6B' },
  { value: 'Other',     label: 'Other', badge: '••', color: '#4B535C' },
];

// Handed out in order to newly added categories.
export const CATEGORY_COLORS = [
  '#7CA3F2', '#E9A6D0', '#F2A65C', '#5BC7A6',
  '#B69CF2', '#F2D56B', '#6BD0E0', '#E07A7A',
];
