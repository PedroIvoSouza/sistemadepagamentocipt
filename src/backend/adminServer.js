import express from 'express';
import adminDarsRoutes from './adminDarsRoutes.js';

const app = express();
app.use('/admin/dars', adminDarsRoutes);

export default app;

if (process.env.RUN_SERVER) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log(`Admin DAR server running on port ${PORT}`)
  );
}
