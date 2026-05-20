import { useDashboardContext } from '../context/DashboardContext';

export function useToast() {
  const { toast, setToast } = useDashboardContext();
  return { toast, setToast };
}
