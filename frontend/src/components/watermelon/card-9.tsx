// Watermelon card-9; registry markup retained. Content supplied by agent wiring.
import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type TextCard = {
  body: ReactNode;
  title: ReactNode;
  className?: string;
};

const Card9 = ({ title, body, className = '' }: TextCard) => {
  return (
    <Card className={`wm-card ${className}`}>
      <CardHeader className="wm-card-header">
        <CardTitle className="wm-card-title">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="wm-card-content">
        {body}
      </CardContent>
    </Card>
  );
};

export default Card9;
