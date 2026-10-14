import { BrowserRouter, Routes, Route } from 'react-router-dom';
import CreateThing from './pages/CreateThing';
import { Guard, Layout } from './components/Field';
import { SessionProvider } from './context/SessionContext';

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/things"
            element={
              <Guard>
                <Layout />
              </Guard>
            }
          >
            <Route path="new" element={<CreateThing />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
