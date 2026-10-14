import { useState } from 'react';
import { thingApi } from '../services/api';
import Field from '../components/Field';

export default function CreateThing() {
  const [form, setForm] = useState({ name: '' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    await thingApi.create({ name: form.name.trim() });
  };

  return (
    <form onSubmit={handleSubmit}>
      <Field value={form.name} onChange={(e) => setForm({ name: e.target.value })} />
    </form>
  );
}
