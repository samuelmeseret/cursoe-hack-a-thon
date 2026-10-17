import { Button } from '@/components/ui/button';
import type { ComponentProps, ReactNode } from 'react';

const Button1 = ({ label, className = '', ...props }: ComponentProps<typeof Button> & { label: ReactNode }) => {
  return <Button variant="default" {...props} className={`wm-button ${className}`}>{label}</Button>;
};

export default Button1;
// Watermelon button-1; project label and disabled state supplied as data.
