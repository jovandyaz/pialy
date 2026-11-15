import { lazy, Suspense } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Loading, Screen, TopBar } from './components/Screen';
import { Button } from './components/ui/Button';
import { BUSINESS } from './lib/business';
import { navigate, ROUTES, useDocumentTitle, useRoute } from './lib/router';

// One chunk per page: a customer opening a pass doesn't download the landing or the agenda.
const LandingPage = lazy(() => import('./routes/LandingPage').then((m) => ({ default: m.LandingPage })));
const BookPage = lazy(() => import('./routes/BookPage').then((m) => ({ default: m.BookPage })));
const WaitPage = lazy(() => import('./routes/WaitPage').then((m) => ({ default: m.WaitPage })));
const BoardPage = lazy(() => import('./routes/BoardPage').then((m) => ({ default: m.BoardPage })));
const LoginPage = lazy(() => import('./routes/LoginPage').then((m) => ({ default: m.LoginPage })));
const VerifyPage = lazy(() => import('./routes/VerifyPage').then((m) => ({ default: m.VerifyPage })));

export function App() {
  const route = useRoute();
  return (
    <ErrorBoundary key={route.name}>
      <Suspense fallback={<Loading />}>
        <Page route={route} />
      </Suspense>
    </ErrorBoundary>
  );
}

function Page({ route }: { readonly route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
    case 'landing':
      return <LandingPage />;
    case 'book':
      return <BookPage />;
    case 'booking':
      return <WaitPage key={route.token} token={route.token} />;
    case 'board':
      return <BoardPage />;
    case 'login':
      return <LoginPage next={route.next} />;
    case 'verify':
      return <VerifyPage key={route.token} token={route.token} />;
    case 'notFound':
      return <NotFound />;
  }
}

function NotFound() {
  useDocumentTitle('Página no encontrada');
  return (
    <Screen>
      <TopBar title={BUSINESS.name} />
      <div className="p-5">
        <h1 className="text-[28px] font-extrabold">Esta página no existe</h1>
        <Button className="mt-4" onClick={() => navigate(ROUTES.book)}>
          Aparta tu cita
        </Button>
      </div>
    </Screen>
  );
}
