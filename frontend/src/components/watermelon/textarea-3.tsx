// Watermelon textarea-3; original label, input, helper structure retained.
import { useId, type ComponentProps } from 'react';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const Textarea3 = ({ label, helper, className = '', ...props }: ComponentProps<'textarea'> & {
  label: string;
  helper: string;
}) => {
  const id = useId();

  return (
    <div className={`wm-textarea ${className}`}>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        {...props}
        className="wm-textarea-input"
      />
      <p className="wm-textarea-helper">
        {helper}
      </p>
    </div>
  );
};

export default Textarea3;
