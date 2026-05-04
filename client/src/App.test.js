import { render, screen } from "@testing-library/react";
import App from "./App";

jest.mock("./pages/HomePage/HomePage", () => () => <div>Home</div>);
jest.mock("./pages/Dashboard", () => () => <div>Dashboard</div>);

test("renders login page title", () => {
  render(<App />);
  expect(
    screen.getByText(/urban road directory portal/i)
  ).toBeInTheDocument();
});
