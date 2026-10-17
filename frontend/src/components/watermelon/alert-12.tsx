
import type { ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';

const Alert12 = ({ text, className = '' }: { text: ReactNode; className?: string }) => {
  return (
    <Alert className={`wm-decision ${className}`}>
      <AlertTitle>{text}</AlertTitle>
    </Alert>
  );
};

export default Alert12;
// Watermelon alert-12; text-only adaptation for the project brief.
