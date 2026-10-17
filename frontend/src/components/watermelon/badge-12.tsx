import { Badge } from '@/components/ui/badge';

const Badge12 = ({ label, className = '' }: { label: ReactNode; className?: string }) => {
  return (
    <Badge className={`wm-status ${className}`}>
      <span
        className="size-1 bg-current"
        aria-hidden="true"
      />
      {label}
    </Badge>
  );
};

export default Badge12;
// Watermelon badge-12; status data supplied by agent wiring.
import type { ReactNode } from 'react';
