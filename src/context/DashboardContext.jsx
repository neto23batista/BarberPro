import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { apiRequest, COOKIE_SESSION } from '../services/api';

const DashboardContext = createContext(null);

const initialState = {
  data: null,
  publicData: { services: [], barbers: [], promotions: [], units: [] },
  storageStatus: null,
  loading: false,
  toast: null
};

function dashboardReducer(state, action) {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: true };
    case 'dashboard_loaded':
      return {
        ...state,
        loading: false,
        data: action.payload,
        storageStatus: action.payload.persistence || state.storageStatus
      };
    case 'public_loaded':
      return {
        ...state,
        publicData: action.payload,
        storageStatus: action.payload.persistence || state.storageStatus
      };
    case 'storage':
      return { ...state, storageStatus: action.payload };
    case 'toast':
      return { ...state, toast: action.payload };
    default:
      return state;
  }
}

export function DashboardProvider({ children }) {
  const [state, dispatch] = useReducer(dashboardReducer, initialState);

  const setToast = useCallback((toast) => {
    dispatch({ type: 'toast', payload: toast });
  }, []);

  const loadPublicData = useCallback(async () => {
    const payload = await apiRequest('/api/public');
    dispatch({ type: 'public_loaded', payload });
    return payload;
  }, []);

  const refreshDashboard = useCallback(async (token = COOKIE_SESSION, options = {}) => {
    if (!token) return null;
    dispatch({ type: 'loading' });
    try {
      const payload = await apiRequest('/api/dashboard', { token });
      dispatch({ type: 'dashboard_loaded', payload });
      return payload;
    } catch (error) {
      if (!options.silent) setToast({ type: 'error', message: error.message });
      throw error;
    }
  }, [setToast]);

  const checkStorageHealth = useCallback(async () => {
    const response = await fetch('/api/health', { credentials: 'include' });
    const payload = await response.json();
    dispatch({ type: 'storage', payload: payload.persistence || null });
    return payload;
  }, []);

  const value = useMemo(() => ({
    ...state,
    setToast,
    loadPublicData,
    refreshDashboard,
    checkStorageHealth
  }), [state, setToast, loadPublicData, refreshDashboard, checkStorageHealth]);

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboardContext() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('useDashboardContext deve ser usado dentro de DashboardProvider.');
  return value;
}
