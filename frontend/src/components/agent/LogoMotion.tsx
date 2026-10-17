import { createContext, useEffect, useState, type ReactNode } from 'react'

export const LogoDirectionContext = createContext(false)

export function LogoMotion({ decision, children }: { decision?: number; children: ReactNode }) {
  const [reverse, setReverse] = useState(false)
  useEffect(() => {
    setReverse(decision !== undefined)
    if (decision === undefined) return
    const timer = setTimeout(() => setReverse(false), 1000)
    return () => clearTimeout(timer)
  }, [decision])
  return <LogoDirectionContext.Provider value={reverse}>{children}</LogoDirectionContext.Provider>
}
