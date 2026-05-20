import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { apiRequest, COOKIE_SESSION } from '../services/api';

const AuthContext = createContext(null);

const initialState = {
  token: '',
  user: null,
  loading: false,
  sessionChecked: false,
  error: null
};

function authReducer(state, action) {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: true, error: null };
    case 'authenticated':
      return {
        ...state,
        loading: false,
        sessionChecked: true,
        token: COOKIE_SESSION,
        user: action.user,
        error: null
      };
    case 'anonymous':
      return { ...initialState, sessionChecked: true };
    case 'error':
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  const login = useCallback(async (email, password) => {
    dispatch({ type: 'loading' });
    try {
      const payload = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      });
      dispatch({ type: 'authenticated', user: payload.user });
      return payload.user;
    } catch (error) {
      dispatch({ type: 'error', error: error.message });
      throw error;
    }
  }, []);

  const register = useCallback(async (form) => {
    dispatch({ type: 'loading' });
    try {
      const payload = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: form
      });
      dispatch({ type: 'authenticated', user: payload.user });
      return payload.user;
    } catch (error) {
      dispatch({ type: 'error', error: error.message });
      throw error;
    }
  }, []);

  const restoreSession = useCallback(async () => {
    dispatch({ type: 'loading' });
    try {
      const payload = await apiRequest('/api/dashboard', { token: COOKIE_SESSION });
      dispatch({ type: 'authenticated', user: payload.user });
      return payload;
    } catch {
      dispatch({ type: 'anonymous' });
      return null;
    }
  }, []);

  const logout = useCallback(async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    dispatch({ type: 'anonymous' });
  }, []);

  const value = useMemo(() => ({
    ...state,
    login,
    register,
    restoreSession,
    logout
  }), [state, login, register, restoreSession, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuthContext deve ser usado dentro de AuthProvider.');
  return value;
}
