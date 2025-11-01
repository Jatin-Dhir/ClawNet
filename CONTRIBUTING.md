# Contributing to ProjectClawNet

Thank you for your interest in contributing to ProjectClawNet! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community
- Show empathy towards others

## Getting Started

1. **Fork the repository**
2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/ClawNet.git
   cd ClawNet
   ```
3. **Install dependencies**
   ```bash
   npm install
   ```
4. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Before Making Changes

1. Run linting:
   ```bash
   npm run lint
   ```
2. Fix any issues:
   ```bash
   npm run lint:fix
   ```
3. Format code:
   ```bash
   npm run format
   ```
4. Run security audit:
   ```bash
   npm run security:audit
   ```

### Making Changes

1. **Write clean code**

   - Follow ESLint rules
   - Use functional components
   - Keep functions small and focused
   - Add comments for complex logic

2. **Test your changes**

   ```bash
   npm run build
   npm run dev  # Test in browser
   ```

3. **Commit your changes**

   ```bash
   git add .
   git commit -m "Description of your changes"
   ```

   Commit message guidelines:

   - Use present tense: "Add feature" not "Added feature"
   - Be descriptive but concise
   - Reference issue numbers if applicable

4. **Push to your fork**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create Pull Request**
   - Go to GitHub repository
   - Click "New Pull Request"
   - Select your branch
   - Fill out PR template
   - Submit

## Code Style

### JavaScript/React

- Use functional components with hooks
- Use const/let, avoid var
- Use arrow functions
- Use template literals for strings
- Destructure props
- Keep components under 200 lines

### Example:

```jsx
// Good
const MyComponent = ({ title, onClick }) => {
  const [count, setCount] = useState(0);

  return (
    <button
      onClick={() => {
        setCount(count + 1);
        onClick?.();
      }}
    >
      {title}: {count}
    </button>
  );
};

// Bad
function MyComponent(props) {
  var count = 0;
  return (
    <button
      onClick={function () {
        count++;
      }}
    >
      {props.title}
    </button>
  );
}
```

### File Naming

- Components: PascalCase (e.g., `Navbar.jsx`)
- Utilities: camelCase (e.g., `fileStorage.js`)
- Constants: UPPER_SNAKE_CASE (e.g., `API_ENDPOINTS.js`)

## Pull Request Process

1. **Update README** if needed
2. **Add tests** if applicable
3. **Update documentation** if adding features
4. **Ensure all checks pass**
5. **Request review** from maintainers

### PR Template

```markdown
## Description

Brief description of changes

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing

Describe tests performed

## Checklist

- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings/errors
```

## Reporting Bugs

1. **Check existing issues** - might already be reported
2. **Create new issue** with:
   - Clear title
   - Description
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser/OS info
   - Screenshots if applicable

## Feature Requests

1. **Check existing issues** for similar requests
2. **Create feature request issue** with:
   - Use case
   - Proposed solution
   - Alternatives considered

## Questions?

- Email: contact@projectclawnet.online
- GitHub Issues: For bug reports and feature requests

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
