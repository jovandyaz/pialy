import { Screen, TopBar } from './components/Screen';
import { Button } from './components/ui/Button';
import { BUSINESS } from './lib/business';
import { navigate, ROUTES, useRoute } from './lib/router';
import { BoardPage } from './routes/BoardPage';
import { BookPage } from './routes/BookPage';
import { LoginPage } from './routes/LoginPage';
import { VerifyPage } from './routes/VerifyPage';
import { WaitPage } from './routes/WaitPage';

export function App() {
  const route = useRoute();
  switch (route.name) {
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
}
