import { Card, CardContent } from '@/components/ui/card';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';

type CardTab = {
  content: ReactNode;
  label: string;
  value: string;
};

const Card10 = ({ tabs, className = '' }: { tabs: readonly CardTab[]; className?: string }) => {
  return (
    <Card className={`wm-tab-card ${className}`}>
      <CardContent className="wm-tab-card-content">
        <Tabs defaultValue={tabs[0]?.value} className="wm-tabs">
          <TabsList className="wm-tab-list">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="wm-tab"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value} className="wm-tab-panel">
              <div className="wm-tab-copy">
                {tab.content}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
};

export default Card10;
// Watermelon card-10. Rich tab content uses a div to allow semantic code and sections.
import type { ReactNode } from 'react';
