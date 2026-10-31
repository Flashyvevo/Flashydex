import { render, screen } from '@testing-library/react';
import { FlashyDexHome } from '../routes/index';

vi.mock('../platform/sqlite', () => ({
  readSqliteVersion: vi.fn().mockResolvedValue('3.49.1')
}));

test('renders the FlashyDex heading and SQLite driver result', async () => {
  render(<FlashyDexHome />);
  expect(screen.getByRole('heading', { name: 'FlashyDex' })).toBeInTheDocument();
  expect(await screen.findByText('SQLite 3.49.1')).toBeInTheDocument();
});
