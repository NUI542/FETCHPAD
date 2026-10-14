import { createContext, useEffect, useState } from 'react';
import { thingApi } from '../services/api';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [mine, setMine] = useState([]);
  useEffect(() => {
    thingApi.getMine().then(setMine);
  }, []);
  return <SessionContext.Provider value={{ mine }}>{children}</SessionContext.Provider>;
}
