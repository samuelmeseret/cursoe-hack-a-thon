import { Badge } from '@/components/ui/badge';

const Badge1 = ({ label, className = '' }: { label: ReactNode; className?: string }) => {
  return <Badge variant="default" className={`wm-label ${className}`}>{label}</Badge>;
};

export default Badge1;
// Watermelon badge-1; label supplied by agent wiring.
import type { ReactNode } from 'react';
