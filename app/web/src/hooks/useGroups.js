import { useCallback, useEffect, useState } from 'react';
export function useGroups(api) {
  const [state, setState] = useState({ groups: [], loading: true, error: null });
  const refresh = useCallback(async () => { setState((s) => ({ ...s, loading: true, error: null })); try { setState({ groups: await api.listGroups(), loading: false, error: null }); } catch (error) { setState({ groups: [], loading: false, error }); } }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { ...state, refresh };
}
