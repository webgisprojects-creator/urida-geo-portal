import { render, screen } from "@testing-library/react";
import App from "./App";

jest.mock("./pages/HomePage/HomePage", () => () => <div>Home</div>);
jest.mock("./pages/Dashboard", () => () => <div>Dashboard</div>);

test("renders login page title", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({}),
  });
  render(<App />);
  expect(
    await screen.findByText(/URBAN GEO-PORTAL/i)
  ).toBeInTheDocument();
});
