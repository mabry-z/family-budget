// Sign-in with Supabase Auth. supabase-js keeps the session in localStorage
// and refreshes it on its own, so people stay signed in until they sign out.
import { supabase } from './supabase.js';

const FRIENDLY = {
  'Invalid login credentials': 'That email and password don’t match.',
  'Email not confirmed': 'This account hasn’t been confirmed yet.',
};

function authError(error) {
  return new Error(FRIENDLY[error.message] ?? error.message);
}

// The saved session, or null when signed out.
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw authError(error);
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw authError(error);
  return data.session;
}

// This device only; the other person's phone stays signed in.
export async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw authError(error);
}

export async function changePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw authError(error);
}

// Signed out here, or the session ended (e.g. the password changed elsewhere).
export function onSignedOut(callback) {
  supabase.auth.onAuthStateChange(event => {
    // Supabase warns against awaiting its own calls inside this callback.
    if (event === 'SIGNED_OUT') setTimeout(callback, 0);
  });
}
