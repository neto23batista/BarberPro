import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  BarChart3,
  Bell,
  Building2,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  Copy,
  Crown,
  CreditCard,
  Download,
  Droplets,
  Eye,
  Filter,
  Gem,
  Gift,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  MapPin,
  Megaphone,
  Menu,
  MessageCircle,
  Moon,
  Package,
  Paintbrush,
  Phone,
  Plus,
  QrCode,
  RotateCw,
  Save,
  Scissors,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Smile,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Target,
  TimerReset,
  TrendingUp,
  UserCog,
  UserRound,
  Users,
  WalletCards,
  Waves,
  X
} from 'lucide-react';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

const iconMap = {
  Scissors,
  Sparkles,
  Gem,
  Eye,
  Paintbrush,
  Sun,
  Waves,
  Droplets,
  BadgeCheck,
  Smile,
  Crown
};

const roleLabel = {
  admin: 'Administrador geral',
  owner: 'Dono',
  barber: 'Barbeiro',
  attendant: 'Atendente',
  client: 'Cliente'
};

const statusLabel = {
  scheduled: 'Agendado',
  confirmed: 'Confirmado',
  in_service: 'Em atendimento',
  finished: 'Finalizado',
  cancelled: 'Cancelado',
  no_show: 'Não compareceu'
};

const paymentLabel = {
  pending: 'Pendente',
  paid: 'Pago',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado'
};

const notificationStatusLabel = {
  queued: 'Na fila',
  scheduled: 'Agendado',
  sent: 'Enviado',
  expired: 'Expirado',
  cancelled: 'Cancelado'
};

const waitlistStatusLabel = {
  waiting: 'Aguardando',
  expired: 'Expirado',
  booked: 'Agendado',
  cancelled: 'Cancelado'
};

const paymentIcon = {
  pix: Smartphone,
  card: CreditCard,
  cash: Banknote,
  online: CircleDollarSign
};

const statusOrder = ['scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show'];
const adminRoles = ['admin', 'owner', 'attendant'];
const COOKIE_SESSION = 'cookie-session';
const DEMO_RESET_CONFIRMATION = 'RESTAURAR DEMO';

function todayKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function formatCurrency(value) {
  return currency.format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return 'Sem registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function appBaseUrl() {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL;
  const fallbackUrl = typeof window !== 'undefined' ? window.location.origin : '';
  return String(configuredUrl || fallbackUrl).replace(/\/+$/, '');
}

function buildReviewEvaluationUrl(reviewToken) {
  const url = new URL('/avaliar', `${appBaseUrl()}/`);
  url.searchParams.set('token', reviewToken);
  return url.toString();
}

function isPublicReviewRoute() {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/avaliar';
}

function currentReviewToken() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') || '';
}

function initials(name = 'BP') {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function serviceIcon(service) {
  const Icon = iconMap[service?.icon] || Scissors;
  return <Icon size={20} />;
}

async function apiRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.token && options.token !== COOKIE_SESSION ? { Authorization: `Bearer ${options.token}` } : {})
  };
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || 'Nao foi possivel concluir a solicitacao.');
    error.code = payload?.code;
    error.persistence = payload?.persistence;
    if (error.code === 'PERSISTENCE_UNAVAILABLE') {
      window.dispatchEvent(new CustomEvent('barberpro:persistence-error', { detail: payload.persistence }));
    }
    throw error;
  }
  return payload;
}

async function downloadWithAuth(path, token, filename) {
  const response = await fetch(path, {
    headers: token && token !== COOKIE_SESSION ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include'
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    const error = new Error(payload?.error || 'Falha ao gerar arquivo.');
    error.code = payload?.code;
    if (error.code === 'PERSISTENCE_UNAVAILABLE') {
      window.dispatchEvent(new CustomEvent('barberpro:persistence-error', { detail: payload.persistence }));
    }
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function App() {
  const publicReviewRoute = isPublicReviewRoute();
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [publicData, setPublicData] = useState({ services: [], barbers: [], promotions: [], units: [] });
  const [dashboard, setDashboard] = useState(null);
  const [activePage, setActivePage] = useState('dashboard');
  const [loading, setLoading] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [toast, setToast] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState(null);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('barberpro_theme') !== 'light');

  useEffect(() => {
    document.body.dataset.theme = darkMode ? 'dark' : 'light';
    localStorage.setItem('barberpro_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    apiRequest('/api/public')
      .then((payload) => {
        setPublicData(payload);
        if (payload.persistence) setStorageStatus(payload.persistence);
      })
      .catch(() => setToast({ type: 'error', message: 'API pública indisponível.' }));
  }, []);

  useEffect(() => {
    if (publicReviewRoute) {
      setSessionChecked(true);
      return;
    }
    restoreSession();
  }, [publicReviewRoute]);

  useEffect(() => {
    checkStorageHealth({ silent: true });
    const interval = window.setInterval(() => checkStorageHealth({ silent: true }), 15000);
    const handlePersistenceError = (event) => {
      if (event.detail) setStorageStatus(event.detail);
      checkStorageHealth({ silent: true });
    };
    window.addEventListener('barberpro:persistence-error', handlePersistenceError);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('barberpro:persistence-error', handlePersistenceError);
    };
  }, []);

  async function checkStorageHealth(options = {}) {
    try {
      const response = await fetch('/api/health', { credentials: 'include' });
      const payload = await response.json();
      const persistence = payload.persistence || null;
      setStorageStatus(persistence);
      if (!response.ok && !options.silent) {
        setToast({ type: 'error', message: persistence?.message || 'Persistencia local indisponivel.' });
      }
      return persistence;
    } catch {
      const persistence = {
        mode: 'api',
        status: 'offline',
        writable: false,
        readOnly: true,
        message: 'API local indisponivel. Verifique se o servidor BarberPro esta rodando.'
      };
      setStorageStatus(persistence);
      if (!options.silent) setToast({ type: 'error', message: persistence.message });
      return persistence;
    }
  }

  async function restoreSession() {
    try {
      await refreshDashboard(COOKIE_SESSION, { silent: true });
    } catch {
      setToken('');
    } finally {
      setSessionChecked(true);
    }
  }

  async function refreshDashboard(currentToken = token, options = {}) {
    if (!currentToken) return;
    setLoading(true);
    try {
      const payload = await apiRequest('/api/dashboard', { token: currentToken });
      setDashboard(payload);
      if (payload.persistence) setStorageStatus(payload.persistence);
      setUser(payload.user);
      setToken(COOKIE_SESSION);
    } catch (error) {
      if (!options.silent) setToast({ type: 'error', message: error.message });
      logout({ remote: false });
      throw error;
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(email, password) {
    setLoading(true);
    try {
      const payload = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      });
      setToken(COOKIE_SESSION);
      setUser(payload.user);
      setActivePage(payload.user.role === 'client' ? 'agendamento' : 'dashboard');
      await refreshDashboard(COOKIE_SESSION, { silent: true });
      setToast({ type: 'success', message: 'Login realizado.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(form) {
    setLoading(true);
    try {
      const payload = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: form
      });
      setToken(COOKIE_SESSION);
      setUser(payload.user);
      setActivePage('agendamento');
      await refreshDashboard(COOKIE_SESSION, { silent: true });
      setToast({ type: 'success', message: 'Cadastro criado.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    } finally {
      setLoading(false);
    }
  }

  async function logout(options = {}) {
    if (options.remote !== false) {
      await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    setToken('');
    setUser(null);
    setDashboard(null);
  }

  async function updateAppointmentStatus(appointmentId, status) {
    try {
      await apiRequest(`/api/appointments/${appointmentId}/status`, {
        method: 'POST',
        token,
        body: { status, paymentStatus: status === 'finished' ? 'paid' : undefined }
      });
      setToast({ type: 'success', message: `Status alterado para ${statusLabel[status]}.` });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  async function cancelAppointment(appointmentId) {
    try {
      await apiRequest(`/api/appointments/${appointmentId}/cancel`, {
        method: 'POST',
        token,
        body: { reason: 'Cancelado pelo painel BarberPro.' }
      });
      setToast({ type: 'success', message: 'Agendamento cancelado.' });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  async function reconcileOperationalItems() {
    try {
      const payload = await apiRequest('/api/operations/reconcile', {
        method: 'POST',
        token
      });
      const total = payload.summary?.totalUpdated || 0;
      setToast({
        type: 'success',
        message: total
          ? `Reconciliação aplicada em ${total} item(ns).`
          : 'Reconciliação concluída sem novas pendências.'
      });
      await refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  if (!sessionChecked) {
    return <LoadingState />;
  }

  if (publicReviewRoute) {
    return (
      <>
        <PublicReviewPage
          storageStatus={storageStatus}
          onRetryStorage={() => checkStorageHealth({ silent: false })}
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode((value) => !value)}
        />
      </>
    );
  }

  if (!user || !token) {
    return (
      <>
        <PublicExperience
          publicData={publicData}
          loading={loading}
          onLogin={handleLogin}
          onRegister={handleRegister}
          storageStatus={storageStatus}
          onRetryStorage={() => checkStorageHealth({ silent: false })}
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode((value) => !value)}
        />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  const navItems = buildNav(user.role);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">BP</div>
          <div>
            <strong>BarberPro</strong>
            <span>Gestão premium</span>
          </div>
        </div>
        <nav className="side-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={activePage === item.id ? 'active' : ''}
              onClick={() => {
                setActivePage(item.id);
                setSidebarOpen(false);
              }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <RoleBadge role={user.role} />
          <button className="ghost-button" onClick={logout}>
            <LogOut size={17} />
            Sair
          </button>
        </div>
      </aside>
      <button className={`sidebar-backdrop ${sidebarOpen ? 'show' : ''}`} onClick={() => setSidebarOpen(false)} aria-label="Fechar menu" />

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Abrir menu">
            <Menu size={20} />
          </button>
          <div>
            <span className="eyebrow">Sistema comercial</span>
            <h1>{pageTitle(activePage)}</h1>
            <p>{pageDescription(activePage)}</p>
          </div>
          <div className="topbar-actions">
            {dashboard && <QuickSearch data={dashboard} setActivePage={setActivePage} />}
            <button className="icon-button" onClick={() => setDarkMode((value) => !value)} aria-label="Alternar tema">
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="icon-button" onClick={() => refreshDashboard()} aria-label="Atualizar painel">
              <RotateCw size={18} />
            </button>
            <div className="user-chip">
              <span>{initials(user.name)}</span>
              <div>
                <strong>{user.name}</strong>
                <small>{roleLabel[user.role]}</small>
              </div>
            </div>
          </div>
        </header>

        <PersistenceBanner status={storageStatus} onRetry={() => checkStorageHealth({ silent: false })} />
        {loading && <div className="loading-bar" />}
        {dashboard ? (
          <PageRouter
            page={activePage}
            user={user}
            data={dashboard}
            token={token}
            publicData={publicData}
            setActivePage={setActivePage}
            setToast={setToast}
            refreshDashboard={refreshDashboard}
            updateAppointmentStatus={updateAppointmentStatus}
            cancelAppointment={cancelAppointment}
            reconcileOperationalItems={reconcileOperationalItems}
          />
        ) : (
          <LoadingState />
        )}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function buildNav(role) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'owner', 'attendant', 'barber'] },
    { id: 'agendamento', label: 'Agendar', icon: CalendarPlus, roles: ['admin', 'owner', 'attendant', 'client'] },
    { id: 'agenda', label: 'Agenda', icon: CalendarDays, roles: ['admin', 'owner', 'attendant', 'barber', 'client'] },
    { id: 'cliente', label: 'Cliente', icon: UserRound, roles: ['admin', 'owner', 'attendant', 'client'] },
    { id: 'barbeiro', label: 'Barbeiro', icon: Scissors, roles: ['admin', 'owner', 'attendant', 'barber'] },
    { id: 'admin', label: 'Admin', icon: ShieldCheck, roles: ['admin', 'owner', 'attendant'] },
    { id: 'servicos', label: 'Serviços', icon: ClipboardList, roles: ['admin', 'owner', 'attendant', 'client'] },
    { id: 'barbeiros', label: 'Barbeiros', icon: Users, roles: ['admin', 'owner', 'attendant', 'client'] },
    { id: 'financeiro', label: 'Financeiro', icon: WalletCards, roles: ['admin', 'owner', 'attendant', 'barber'] },
    { id: 'estoque', label: 'Estoque', icon: Package, roles: ['admin', 'owner', 'attendant'] },
    { id: 'relatorios', label: 'Relatórios', icon: BarChart3, roles: ['admin', 'owner', 'attendant', 'barber'] },
    { id: 'avaliacoes', label: 'Avaliações', icon: Star, roles: ['admin', 'owner', 'attendant', 'barber', 'client'] },
    { id: 'promocoes', label: 'Promoções', icon: Megaphone, roles: ['admin', 'owner', 'attendant', 'client'] },
    { id: 'configuracoes', label: 'Configurações', icon: Settings, roles: ['admin', 'owner'] },
    { id: 'suporte', label: 'Suporte', icon: MessageCircle, roles: ['admin', 'owner', 'attendant', 'barber', 'client'] }
  ];
  return items.filter((item) => item.roles.includes(role));
}

function pageTitle(page) {
  const map = {
    dashboard: 'Dashboard inicial',
    agendamento: 'Agendamento',
    agenda: 'Agenda inteligente',
    cliente: 'Área do cliente',
    barbeiro: 'Área do barbeiro',
    admin: 'Administração',
    servicos: 'Serviços',
    barbeiros: 'Barbeiros',
    financeiro: 'Financeiro',
    estoque: 'Estoque',
    relatorios: 'Relatórios',
    avaliacoes: 'Avaliações',
    promocoes: 'Promoções',
    configuracoes: 'Configurações',
    suporte: 'Suporte e contato'
  };
  return map[page] || 'BarberPro';
}

function pageDescription(page) {
  const map = {
    dashboard: 'Indicadores, agenda do dia e saúde operacional em tempo real.',
    agendamento: 'Escolha cliente, serviço, barbeiro e horário sem conflito.',
    agenda: 'Controle visual de atendimentos por status, data e profissional.',
    cliente: 'Histórico, fidelidade, faltas, cupons e preferências.',
    barbeiro: 'Agenda individual, bloqueios, metas, comissões e avaliações.',
    admin: 'Central de gestão para clientes, equipe, serviços, produtos e logs.',
    servicos: 'Catálogo comercial com preços, duração e profissionais habilitados.',
    barbeiros: 'Equipe, especialidades, avaliações e desempenho.',
    financeiro: 'Pagamentos, comissões, despesas e lucro estimado.',
    estoque: 'Produtos, alertas de mínimo e movimentações de inventário.',
    relatorios: 'Gráficos, rankings e exportações para tomada de decisão.',
    avaliacoes: 'Feedback dos clientes e QR Code de avaliação.',
    promocoes: 'Campanhas, combos, cupons e automações comerciais.',
    configuracoes: 'Regras de agenda, segurança, unidades e backup.',
    suporte: 'Canais de contato, mensagens e integrações.'
  };
  return map[page] || 'Operação BarberPro.';
}

function PageRouter(props) {
  const pageMap = {
    dashboard: <DashboardPage {...props} />,
    agendamento: <BookingPage {...props} />,
    agenda: <SchedulePage {...props} />,
    cliente: <ClientPage {...props} />,
    barbeiro: <BarberPage {...props} />,
    admin: <AdminPage {...props} />,
    servicos: <ServicesPage {...props} />,
    barbeiros: <BarbersPage {...props} />,
    financeiro: <FinancePage {...props} />,
    estoque: <InventoryPage {...props} />,
    relatorios: <ReportsPage {...props} />,
    avaliacoes: <ReviewsPage {...props} />,
    promocoes: <PromotionsPage {...props} />,
    configuracoes: <SettingsPage {...props} />,
    suporte: <SupportPage {...props} />
  };
  return pageMap[props.page] || pageMap.dashboard;
}

function QuickSearch({ data, setActivePage }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];

    const entries = [
      ...data.clients.map((client) => ({
        id: `client-${client.id}`,
        type: 'Cliente',
        label: client.name,
        meta: client.phone || client.email,
        page: 'cliente'
      })),
      ...data.appointments.map((appointment) => ({
        id: `appointment-${appointment.id}`,
        type: 'Agenda',
        label: `${appointment.client?.name || 'Cliente'} · ${appointment.startTime}`,
        meta: `${appointment.service?.name || 'Serviço'} em ${appointment.date}`,
        page: 'agenda'
      })),
      ...data.services.map((service) => ({
        id: `service-${service.id}`,
        type: 'Serviço',
        label: service.name,
        meta: `${service.durationMinutes} min · ${formatCurrency(service.price)}`,
        page: 'servicos'
      })),
      ...data.products.map((product) => ({
        id: `product-${product.id}`,
        type: 'Estoque',
        label: product.name,
        meta: `${product.quantity} un. · ${product.category}`,
        page: 'estoque'
      })),
      ...data.promotions.map((promotion) => ({
        id: `promotion-${promotion.id}`,
        type: 'Promoção',
        label: promotion.title,
        meta: promotion.code,
        page: 'promocoes'
      }))
    ];

    return entries
      .filter((entry) => `${entry.type} ${entry.label} ${entry.meta}`.toLowerCase().includes(term))
      .slice(0, 6);
  }, [data, query]);

  return (
    <div className="quick-search">
      <Search size={16} />
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar"
        aria-label="Busca global"
      />
      {open && query && (
        <div className="quick-results">
          {results.map((result) => (
            <button
              key={result.id}
              onClick={() => {
                setActivePage(result.page);
                setQuery('');
                setOpen(false);
              }}
            >
              <span>{result.type}</span>
              <strong>{result.label}</strong>
              <small>{result.meta}</small>
            </button>
          ))}
          {!results.length && <div className="quick-empty">Nenhum resultado encontrado.</div>}
        </div>
      )}
    </div>
  );
}

function PublicExperience({ publicData, loading, onLogin, onRegister, storageStatus, onRetryStorage, darkMode, onToggleTheme }) {
  const [mode, setMode] = useState('login');
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [registerForm, setRegisterForm] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
    birthDate: ''
  });

  return (
    <div className="public-shell">
      <header className="public-header">
        <div className="brand">
          <div className="brand-mark">BP</div>
          <div>
            <strong>BarberPro</strong>
            <span>Agenda, gestão e fidelidade</span>
          </div>
        </div>
        <button className="icon-button" onClick={onToggleTheme} aria-label="Alternar tema">
          {darkMode ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>

      <PersistenceBanner status={storageStatus} onRetry={onRetryStorage} publicView />
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Barbearia premium conectada</span>
          <h1>BarberPro</h1>
          <p>
            Agenda inteligente, atendimento com histórico, pagamentos, estoque, comissões, relatórios e fidelidade em
            uma operação centralizada.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#acesso">
              <CalendarPlus size={18} />
              Agendar agora
            </a>
            <a className="outline-button" href={`https://wa.me/${publicData.settings?.whatsappNumber || '5511999999999'}`}>
              <MessageCircle size={18} />
              WhatsApp
            </a>
          </div>
          <div className="proof-strip">
            <span><ShieldCheck size={16} /> Permissões por perfil</span>
            <span><Bell size={16} /> Lembretes automáticos</span>
            <span><WalletCards size={16} /> Financeiro integrado</span>
          </div>
        </div>
        <div className="hero-metrics">
          <MetricMini label="Serviços ativos" value={publicData.services.length} />
          <MetricMini label="Barbeiros" value={publicData.barbers.length} />
          <MetricMini label="Promoções" value={publicData.promotions.length} />
        </div>
      </section>

      <section className="public-grid" id="acesso">
        <div className="auth-panel">
          <div className="segmented">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Login
            </button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              Cadastro
            </button>
          </div>

          {mode === 'login' ? (
            <form
              className="stack-form"
              onSubmit={(event) => {
                event.preventDefault();
                onLogin(loginForm.email, loginForm.password);
              }}
            >
              <Input label="E-mail" value={loginForm.email} onChange={(email) => setLoginForm({ ...loginForm, email })} />
              <Input
                label="Senha"
                type="password"
                value={loginForm.password}
                onChange={(password) => setLoginForm({ ...loginForm, password })}
              />
              <button className="primary-button full" disabled={loading}>
                <LockKeyhole size={18} />
                Entrar
              </button>
            </form>
          ) : (
            <form
              className="stack-form"
              onSubmit={(event) => {
                event.preventDefault();
                onRegister(registerForm);
              }}
            >
              <Input label="Nome" value={registerForm.name} onChange={(name) => setRegisterForm({ ...registerForm, name })} />
              <Input
                label="Telefone"
                value={registerForm.phone}
                onChange={(phone) => setRegisterForm({ ...registerForm, phone })}
              />
              <Input
                label="E-mail"
                value={registerForm.email}
                onChange={(email) => setRegisterForm({ ...registerForm, email })}
              />
              <Input
                label="Aniversário"
                type="date"
                value={registerForm.birthDate}
                onChange={(birthDate) => setRegisterForm({ ...registerForm, birthDate })}
              />
              <Input
                label="Senha"
                type="password"
                value={registerForm.password}
                onChange={(password) => setRegisterForm({ ...registerForm, password })}
              />
              <button className="primary-button full" disabled={loading}>
                <UserRound size={18} />
                Criar conta
              </button>
            </form>
          )}
        </div>

        <div className="public-services">
          <SectionHeading eyebrow="Catálogo" title="Serviços em destaque" />
          <div className="service-mini-grid">
            {publicData.services.slice(0, 6).map((service) => (
              <article className="service-mini" key={service.id}>
                <span style={{ color: service.color }}>{serviceIcon(service)}</span>
                <strong>{service.name}</strong>
                <small>{service.durationMinutes} min</small>
                <b>{formatCurrency(service.price)}</b>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function PublicReviewPage({ storageStatus, onRetryStorage, darkMode, onToggleTheme }) {
  const [reviewRequest, setReviewRequest] = useState(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const reviewToken = useMemo(() => currentReviewToken(), []);

  useEffect(() => {
    let active = true;

    async function loadReviewRequest() {
      if (!reviewToken) {
        setMessage({ type: 'error', text: 'Link de avaliação inválido.' });
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const payload = await apiRequest(`/api/public/review-request?token=${encodeURIComponent(reviewToken)}`);
        if (!active) return;
        setReviewRequest(payload);
        setMessage(null);
      } catch (error) {
        if (active) setMessage({ type: 'error', text: error.message });
      } finally {
        if (active) setLoading(false);
      }
    }

    loadReviewRequest();
    return () => {
      active = false;
    };
  }, [reviewToken]);

  async function submitReview(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    try {
      const payload = await apiRequest('/api/public/reviews', {
        method: 'POST',
        body: {
          token: reviewToken,
          rating,
          comment
        }
      });
      setReviewRequest(payload);
      setMessage({ type: 'success', text: 'Avaliação registrada. Obrigado pelo feedback.' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  const appointment = reviewRequest?.appointment;
  const canReview = appointment?.canReview && message?.type !== 'success';
  const blockedMessage = message?.type === 'success'
    ? null
    : appointment?.alreadyReviewed
      ? 'Este atendimento já recebeu avaliação.'
      : appointment && appointment.status !== 'finished'
        ? 'Este atendimento ainda não foi finalizado.'
        : null;

  return (
    <div className="review-public-shell">
      <header className="public-header">
        <div className="brand">
          <div className="brand-mark">BP</div>
          <div>
            <strong>BarberPro</strong>
            <span>Avaliação de atendimento</span>
          </div>
        </div>
        <button className="icon-button" onClick={onToggleTheme} aria-label="Alternar tema">
          {darkMode ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>

      <PersistenceBanner status={storageStatus} onRetry={onRetryStorage} publicView />

      <main className="review-public-main">
        <section className="review-public-card">
          {loading ? (
            <LoadingState />
          ) : (
            <>
              <div className="review-public-heading">
                <span className="eyebrow">Feedback</span>
                <h1>{appointment ? appointment.service?.name || 'Atendimento BarberPro' : 'Avaliação indisponível'}</h1>
                {appointment && (
                  <div className="review-summary">
                    <div>
                      <CalendarDays size={18} />
                      <span>{appointment.date} · {appointment.startTime}</span>
                    </div>
                    <div>
                      <Scissors size={18} />
                      <span>{appointment.barber?.name || 'Barbeiro'}</span>
                    </div>
                    <div>
                      <MapPin size={18} />
                      <span>{appointment.unit?.name || 'Unidade'}</span>
                    </div>
                    <StatusPill status={appointment.status} label={statusLabel[appointment.status] || appointment.status} />
                  </div>
                )}
              </div>

              {message && <div className={`form-message ${message.type}`}>{message.text}</div>}
              {blockedMessage && <div className="form-message neutral">{blockedMessage}</div>}

              {canReview && (
                <form className="stack-form" onSubmit={submitReview}>
                  <label className="field">
                    <span>Nota</span>
                    <div className="review-score-picker" role="radiogroup" aria-label="Nota do atendimento">
                      {Array.from({ length: 5 }, (_, index) => {
                        const value = index + 1;
                        return (
                          <button
                            type="button"
                            key={value}
                            className={value <= rating ? 'active' : ''}
                            aria-pressed={value === rating}
                            aria-label={`${value} estrela${value > 1 ? 's' : ''}`}
                            onClick={() => setRating(value)}
                          >
                            <Star size={24} fill={value <= rating ? 'currentColor' : 'none'} />
                          </button>
                        );
                      })}
                    </div>
                  </label>
                  <Textarea label="Comentário" value={comment} onChange={setComment} />
                  <button className="primary-button full" disabled={submitting}>
                    <Send size={18} />
                    Enviar avaliação
                  </button>
                </form>
              )}

              {!appointment && !message && <EmptyState text="Link de avaliação inválido." />}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function DashboardPage({ data, setActivePage }) {
  const kpis = data.reports.kpis;
  const nextAppointments = data.appointments
    .filter((appointment) => ['scheduled', 'confirmed', 'in_service'].includes(appointment.status))
    .slice(0, 5);
  const nextAppointment = nextAppointments[0];
  const operationHealth = Math.max(
    0,
    Math.round(100 - Number(kpis.cancellationRate || 0) - Number(kpis.noShowRate || 0) - Number(kpis.lowStock || 0) * 4)
  );

  return (
    <div className="page-grid">
      <section className="dashboard-hero">
        <div className="hero-summary">
          <span className="eyebrow">Operação ao vivo</span>
          <h2>{operationHealth}% de saúde operacional</h2>
          <p>
            {nextAppointment
              ? `Próximo atendimento: ${nextAppointment.client?.name} às ${nextAppointment.startTime}, com ${nextAppointment.barber?.name}.`
              : 'Nenhum atendimento pendente no momento.'}
          </p>
          <div className="hero-summary-actions">
            <button className="primary-button" onClick={() => setActivePage('agendamento')}>
              <CalendarPlus size={18} />
              Novo horário
            </button>
            <button className="outline-button" onClick={() => setActivePage('relatorios')}>
              <BarChart3 size={18} />
              Ver relatórios
            </button>
          </div>
        </div>
        <div className="hero-status-grid">
          <MetricMini label="Cancelamento" value={`${kpis.cancellationRate}%`} />
          <MetricMini label="Faltas" value={`${kpis.noShowRate}%`} />
          <MetricMini label="Estoque baixo" value={kpis.lowStock} />
        </div>
      </section>

      <div className="kpi-grid">
        <KpiCard icon={CircleDollarSign} label="Faturamento hoje" value={formatCurrency(kpis.revenueToday)} accent="gold" />
        <KpiCard icon={TrendingUp} label="Faturamento mensal" value={formatCurrency(kpis.revenueMonth)} accent="blue" />
        <KpiCard icon={CalendarDays} label="Agendamentos" value={kpis.totalAppointments} accent="red" />
        <KpiCard icon={WalletCards} label="Ticket médio" value={formatCurrency(kpis.averageTicket)} accent="green" />
      </div>

      <section className="panel wide">
        <SectionHeading eyebrow="Receita" title="Faturamento e volume mensal" action={<ChartLegend />} />
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data.reports.monthlyRevenue}>
              <defs>
                <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#d5a84f" stopOpacity={0.7} />
                  <stop offset="95%" stopColor="#d5a84f" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="revenue" stroke="#d5a84f" fill="url(#revenueGradient)" strokeWidth={3} />
              <Line type="monotone" dataKey="appointments" stroke="#1f5f9f" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Hoje" title="Próximos atendimentos" />
        <div className="timeline-list">
          {nextAppointments.map((appointment) => (
            <AppointmentRow appointment={appointment} key={appointment.id} compact />
          ))}
          {!nextAppointments.length && <EmptyState text="Nenhum atendimento pendente." />}
        </div>
        <button className="outline-button full" onClick={() => setActivePage('agenda')}>
          <CalendarDays size={18} />
          Ver agenda
        </button>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Desempenho" title="Barbeiros" />
        <div className="barber-performance">
          {data.reports.barberPerformance.map((barber) => (
            <div className="performance-row" key={barber.name}>
              <div>
                <strong>{barber.name}</strong>
                <span>{barber.appointments} atendimentos</span>
              </div>
              <progress value={barber.revenue} max={barber.goal || 1} />
              <b>{formatCurrency(barber.revenue)}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Alertas" title="Operação" />
        <div className="alert-list">
          <AlertLine icon={AlertTriangle} label="Estoque baixo" value={`${kpis.lowStock} produto(s)`} />
          <AlertLine icon={TimerReset} label="Cancelamentos" value={`${kpis.cancellationRate}%`} />
          <AlertLine icon={UserCog} label="Não compareceu" value={`${kpis.noShowRate}%`} />
          <AlertLine icon={Bell} label="Notificações" value={`${data.notifications.length} registros`} />
        </div>
      </section>
    </div>
  );
}

function BookingPage({ data, token, user, refreshDashboard, setToast }) {
  const defaultService = data.services.find((service) => service.active)?.id || '';
  const defaultBarber = data.barbers[0]?.id || '';
  const defaultClient = user.role === 'client' ? user.clientId : data.clients[0]?.id || '';
  const [form, setForm] = useState({
    clientId: defaultClient,
    serviceId: defaultService,
    barberId: defaultBarber,
    date: todayKey(1),
    startTime: '',
    paymentMethod: 'pix',
    allowFitIn: false,
    notes: ''
  });
  const [availability, setAvailability] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const selectedService = data.services.find((service) => service.id === form.serviceId);
  const allowedBarbers = data.barbers.filter((barber) => selectedService?.barberIds.includes(barber.id));

  useEffect(() => {
    if (!form.serviceId) return;
    const firstAllowed = data.barbers.find((barber) => selectedService?.barberIds.includes(barber.id));
    if (firstAllowed && !selectedService?.barberIds.includes(form.barberId)) {
      setForm((current) => ({ ...current, barberId: firstAllowed.id, startTime: '' }));
    }
  }, [form.serviceId]);

  useEffect(() => {
    loadAvailability();
  }, [form.serviceId, form.barberId, form.date]);

  async function loadAvailability() {
    if (!form.serviceId || !form.date) return;
    setLoadingSlots(true);
    try {
      const params = new URLSearchParams({
        serviceId: form.serviceId,
        barberId: form.barberId,
        date: form.date
      });
      const payload = await apiRequest(`/api/availability?${params.toString()}`);
      setAvailability(payload.availability || []);
    } finally {
      setLoadingSlots(false);
    }
  }

  async function submitBooking(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/appointments', {
        method: 'POST',
        token,
        body: form
      });
      setToast({ type: 'success', message: 'Agendamento criado com confirmação automática.' });
      setForm((current) => ({ ...current, startTime: '', notes: '' }));
      await refreshDashboard();
      await loadAvailability();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="two-column">
      <section className="panel">
        <SectionHeading eyebrow="Novo horário" title="Agendar atendimento" />
        <form className="stack-form" onSubmit={submitBooking}>
          {adminRoles.includes(user.role) && (
            <Select
              label="Cliente"
              value={form.clientId}
              onChange={(clientId) => setForm({ ...form, clientId })}
              options={data.clients.map((client) => ({ label: `${client.name} · ${client.phone}`, value: client.id }))}
            />
          )}
          <Select
            label="Serviço"
            value={form.serviceId}
            onChange={(serviceId) => setForm({ ...form, serviceId, startTime: '' })}
            options={data.services
              .filter((service) => service.active)
              .map((service) => ({
                label: `${service.name} · ${formatCurrency(service.price)} · ${service.durationMinutes} min`,
                value: service.id
              }))}
          />
          <Select
            label="Barbeiro"
            value={form.barberId}
            onChange={(barberId) => setForm({ ...form, barberId, startTime: '' })}
            options={allowedBarbers.map((barber) => ({ label: barber.name, value: barber.id }))}
          />
          <Input label="Data" type="date" value={form.date} onChange={(date) => setForm({ ...form, date, startTime: '' })} />
          <Select
            label="Pagamento"
            value={form.paymentMethod}
            onChange={(paymentMethod) => setForm({ ...form, paymentMethod })}
            options={[
              { label: 'Pix', value: 'pix' },
              { label: 'Cartão', value: 'card' },
              { label: 'Dinheiro', value: 'cash' },
              { label: 'Online', value: 'online' }
            ]}
          />
          <Textarea label="Observações" value={form.notes} onChange={(notes) => setForm({ ...form, notes })} />
          {adminRoles.includes(user.role) && (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={form.allowFitIn}
                onChange={(event) => setForm({ ...form, allowFitIn: event.target.checked })}
              />
              Permitir encaixe autorizado
            </label>
          )}
          <button className="primary-button full" disabled={!form.startTime}>
            <CalendarPlus size={18} />
            Confirmar agendamento
          </button>
        </form>
      </section>

      <section className="panel wide">
        <SectionHeading
          eyebrow={loadingSlots ? 'Carregando' : 'Disponibilidade'}
          title={`${selectedService?.name || 'Serviço'} em ${form.date}`}
        />
        <div className="slot-groups">
          {availability.map((group) => (
            <article className="slot-group" key={group.barberId}>
              <div className="slot-group-head">
                <div className="avatar">{initials(group.barberName)}</div>
                <div>
                  <strong>{group.barberName}</strong>
                  <span>{group.closed ? group.reason : `${group.open} às ${group.close}`}</span>
                </div>
              </div>
              <div className="slot-grid">
                {group.slots.map((slot) => (
                  <button
                    type="button"
                    key={`${group.barberId}-${slot.startTime}`}
                    className={`slot ${form.startTime === slot.startTime && form.barberId === group.barberId ? 'selected' : ''}`}
                    disabled={!slot.available}
                    onClick={() => setForm({ ...form, barberId: group.barberId, startTime: slot.startTime })}
                  >
                    {slot.startTime}
                  </button>
                ))}
              </div>
              {!group.slots.length && <EmptyState text={group.reason || 'Nenhum horário disponível.'} />}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SchedulePage({ data, user, updateAppointmentStatus, cancelAppointment }) {
  const [filters, setFilters] = useState({ date: '', status: '', barberId: '', serviceId: '', search: '' });
  const [view, setView] = useState('daily');

  const filtered = data.appointments
    .filter((appointment) => (!filters.date ? true : appointment.date === filters.date))
    .filter((appointment) => (!filters.status ? true : appointment.status === filters.status))
    .filter((appointment) => (!filters.barberId ? true : appointment.barberId === filters.barberId))
    .filter((appointment) => (!filters.serviceId ? true : appointment.serviceId === filters.serviceId))
    .filter((appointment) =>
      !filters.search
        ? true
        : `${appointment.client?.name} ${appointment.barber?.name} ${appointment.service?.name}`
            .toLowerCase()
            .includes(filters.search.toLowerCase())
    )
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));

  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading
          eyebrow="Filtros"
          title="Agenda visual"
          action={
            <div className="segmented compact">
              {['daily', 'weekly', 'monthly'].map((item) => (
                <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>
                  {item === 'daily' ? 'Dia' : item === 'weekly' ? 'Semana' : 'Mês'}
                </button>
              ))}
            </div>
          }
        />
        <div className="filter-grid">
          <Input label="Data" type="date" value={filters.date} onChange={(date) => setFilters({ ...filters, date })} />
          <Select
            label="Status"
            value={filters.status}
            onChange={(status) => setFilters({ ...filters, status })}
            options={[{ label: 'Todos', value: '' }, ...statusOrder.map((status) => ({ label: statusLabel[status], value: status }))]}
          />
          <Select
            label="Barbeiro"
            value={filters.barberId}
            onChange={(barberId) => setFilters({ ...filters, barberId })}
            options={[{ label: 'Todos', value: '' }, ...data.barbers.map((barber) => ({ label: barber.name, value: barber.id }))]}
          />
          <Select
            label="Serviço"
            value={filters.serviceId}
            onChange={(serviceId) => setFilters({ ...filters, serviceId })}
            options={[{ label: 'Todos', value: '' }, ...data.services.map((service) => ({ label: service.name, value: service.id }))]}
          />
          <Input
            label="Busca rápida"
            value={filters.search}
            onChange={(search) => setFilters({ ...filters, search })}
            icon={Search}
          />
        </div>
      </section>

      <section className="panel wide">
        <div className={`schedule-board ${view}`}>
          {filtered.map((appointment) => (
            <AppointmentCard
              appointment={appointment}
              key={appointment.id}
              canManage={user.role !== 'client'}
              onStatus={updateAppointmentStatus}
              onCancel={cancelAppointment}
            />
          ))}
          {!filtered.length && <EmptyState text="Nenhum agendamento encontrado." />}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Lista de espera" title="Oportunidades" />
        <div className="timeline-list">
          {data.waitlist.map((item) => {
            const client = data.clients.find((clientItem) => clientItem.id === item.clientId);
            const service = data.services.find((serviceItem) => serviceItem.id === item.serviceId);
            return (
              <div className="compact-item" key={item.id}>
                <strong>{client?.name}</strong>
                <span>{service?.name} · {item.preferredDate} · {item.period}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ClientPage({ data, user, setActivePage }) {
  const [search, setSearch] = useState('');
  const currentClient = data.clients.find((client) => client.id === user.clientId) || data.clients[0];
  const visibleClients = adminRoles.includes(user.role)
    ? data.clients.filter((client) => `${client.name} ${client.email} ${client.phone}`.toLowerCase().includes(search.toLowerCase()))
    : [currentClient].filter(Boolean);
  const history = data.appointments.filter((appointment) => appointment.clientId === currentClient?.id);

  return (
    <div className="two-column">
      <section className="panel">
        <SectionHeading eyebrow="Fidelidade" title={currentClient?.name || 'Cliente'} />
        {currentClient && (
          <div className="loyalty-card">
            <div>
              <span>Pontos acumulados</span>
              <strong>{currentClient.loyaltyPoints}</strong>
              <small>{currentClient.visits} visitas · {currentClient.noShows} faltas</small>
            </div>
            <Gift size={42} />
          </div>
        )}
        <div className="reward-list">
          {data.coupons.map((coupon) => (
            <div className="coupon" key={coupon.id}>
              <strong>{coupon.code}</strong>
              <span>{formatCurrency(coupon.discountValue)} até {coupon.expiresAt}</span>
            </div>
          ))}
        </div>
        <button className="primary-button full" onClick={() => setActivePage('agendamento')}>
          <CalendarPlus size={18} />
          Novo agendamento
        </button>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Histórico" title="Atendimentos e observações" />
        {adminRoles.includes(user.role) && (
          <Input label="Buscar cliente" icon={Search} value={search} onChange={setSearch} />
        )}
        <div className="client-grid">
          {visibleClients.map((client) => (
            <article className="client-card" key={client.id}>
              <div className="avatar">{initials(client.name)}</div>
              <div>
                <strong>{client.name}</strong>
                <span>{client.phone}</span>
                <small>{client.tags?.join(' · ')}</small>
              </div>
              <b>{client.loyaltyPoints} pts</b>
            </article>
          ))}
        </div>
        <div className="timeline-list">
          {history.map((appointment) => (
            <AppointmentRow appointment={appointment} key={appointment.id} />
          ))}
          {!history.length && <EmptyState text="Histórico ainda vazio." />}
        </div>
      </section>
    </div>
  );
}

function BarberPage({ data, user, token, refreshDashboard, setToast }) {
  const barber = user.role === 'barber' ? data.barbers.find((item) => item.id === user.barberId) : data.barbers[0];
  const [block, setBlock] = useState({ date: todayKey(1), startTime: '12:00', endTime: '13:00', reason: '' });
  const barberAppointments = data.appointments.filter((appointment) => appointment.barberId === barber?.id);
  const todayAppointments = barberAppointments.filter((appointment) => appointment.date === todayKey());
  const commissions = data.commissions.filter((commission) => commission.barberId === barber?.id);
  const reviews = data.reviews.filter((review) => review.barberId === barber?.id);
  const totalCommission = commissions.reduce((sum, commission) => sum + Number(commission.amount || 0), 0);

  async function createBlock(event) {
    event.preventDefault();
    try {
      await apiRequest(`/api/barbers/${barber.id}/blocks`, {
        method: 'POST',
        token,
        body: block
      });
      setToast({ type: 'success', message: 'Horário bloqueado.' });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <SectionHeading eyebrow="Perfil" title={barber?.name || 'Barbeiro'} />
        <div className="profile-block">
          <div className="avatar large">{initials(barber?.name)}</div>
          <p>{barber?.bio}</p>
          <div className="tag-row">
            {barber?.specialties.map((specialty) => <span key={specialty}>{specialty}</span>)}
          </div>
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Comissão" title="Resultados" />
        <KpiCard icon={CircleDollarSign} label="Comissão disponível" value={formatCurrency(totalCommission)} accent="gold" flat />
        <KpiCard icon={Target} label="Meta mensal" value={formatCurrency(barber?.goalMonthly)} accent="blue" flat />
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Hoje" title="Minha agenda" />
        <div className="timeline-list">
          {todayAppointments.map((appointment) => (
            <AppointmentRow appointment={appointment} key={appointment.id} />
          ))}
          {!todayAppointments.length && <EmptyState text="Nenhum atendimento para hoje." />}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Indisponibilidade" title="Bloquear horário" />
        <form className="stack-form" onSubmit={createBlock}>
          <Input label="Data" type="date" value={block.date} onChange={(date) => setBlock({ ...block, date })} />
          <div className="input-row">
            <Input label="Início" type="time" value={block.startTime} onChange={(startTime) => setBlock({ ...block, startTime })} />
            <Input label="Fim" type="time" value={block.endTime} onChange={(endTime) => setBlock({ ...block, endTime })} />
          </div>
          <Input label="Motivo" value={block.reason} onChange={(reason) => setBlock({ ...block, reason })} />
          <button className="outline-button full">
            <Clock3 size={18} />
            Bloquear
          </button>
        </form>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Avaliações" title="Feedback recebido" />
        <div className="review-grid">
          {reviews.map((review) => (
            <ReviewCard review={review} data={data} key={review.id} />
          ))}
          {!reviews.length && <EmptyState text="Sem avaliações registradas." />}
        </div>
      </section>
    </div>
  );
}

function AdminPage({ data, setActivePage }) {
  const roles = data.user ? [] : [];
  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading eyebrow="Gestão" title="Central administrativa" />
        <div className="admin-action-grid">
          {[
            ['Clientes', data.clients.length, Users, 'cliente'],
            ['Barbeiros', data.barbers.length, Scissors, 'barbeiros'],
            ['Serviços', data.services.length, ClipboardList, 'servicos'],
            ['Produtos', data.products.length, Package, 'estoque'],
            ['Promoções', data.promotions.length, Megaphone, 'promocoes'],
            ['Relatórios', 'PDF/Excel', Download, 'relatorios']
          ].map(([label, value, Icon, page]) => (
            <button className="admin-action" key={label} onClick={() => setActivePage(page)}>
              <Icon size={22} />
              <span>{label}</span>
              <strong>{value}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Permissões" title="Níveis de acesso" />
        <div className="permission-list">
          {['Administrador geral', 'Dono', 'Barbeiro', 'Atendente', 'Cliente'].map((role) => (
            <div className="permission-row" key={role}>
              <ShieldCheck size={18} />
              <span>{role}</span>
              <b>Ativo</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Auditoria" title="Logs importantes" />
        <div className="log-list">
          {data.auditLogs.slice(0, 12).map((log) => (
            <div className="log-row" key={log.id}>
              <span>{log.createdAt.slice(0, 16).replace('T', ' ')}</span>
              <strong>{log.action}</strong>
              <small>{log.details}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ServicesPage({ data, token, refreshDashboard, setToast, user }) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    price: '',
    durationMinutes: '',
    icon: 'Scissors',
    barberIds: []
  });
  const canEdit = adminRoles.includes(user.role);

  async function createService(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/services', { method: 'POST', token, body: form });
      setToast({ type: 'success', message: 'Serviço cadastrado.' });
      setForm({ name: '', description: '', price: '', durationMinutes: '', icon: 'Scissors', barberIds: [] });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="two-column">
      <section className="panel wide">
        <SectionHeading eyebrow="Catálogo" title="Serviços da barbearia" />
        <div className="service-grid">
          {data.services.map((service) => (
            <article className="service-card" key={service.id}>
              <div className="service-icon" style={{ color: service.color }}>
                {serviceIcon(service)}
              </div>
              <div>
                <strong>{service.name}</strong>
                <p>{service.description}</p>
                <span>{service.durationMinutes} min · {formatCurrency(service.price)}</span>
              </div>
              <StatusPill status={service.active ? 'active' : 'inactive'} label={service.active ? 'Ativo' : 'Inativo'} />
            </article>
          ))}
        </div>
      </section>

      {canEdit && (
        <section className="panel">
          <SectionHeading eyebrow="Cadastro" title="Novo serviço" />
          <form className="stack-form" onSubmit={createService}>
            <Input label="Nome" value={form.name} onChange={(name) => setForm({ ...form, name })} />
            <Textarea label="Descrição" value={form.description} onChange={(description) => setForm({ ...form, description })} />
            <div className="input-row">
              <Input label="Preço" type="number" value={form.price} onChange={(price) => setForm({ ...form, price })} />
              <Input
                label="Duração"
                type="number"
                value={form.durationMinutes}
                onChange={(durationMinutes) => setForm({ ...form, durationMinutes })}
              />
            </div>
            <Select
              label="Ícone"
              value={form.icon}
              onChange={(icon) => setForm({ ...form, icon })}
              options={Object.keys(iconMap).map((icon) => ({ label: icon, value: icon }))}
            />
            <div className="check-grid">
              {data.barbers.map((barber) => (
                <label key={barber.id}>
                  <input
                    type="checkbox"
                    checked={form.barberIds.includes(barber.id)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        barberIds: event.target.checked
                          ? [...form.barberIds, barber.id]
                          : form.barberIds.filter((idValue) => idValue !== barber.id)
                      })
                    }
                  />
                  {barber.name}
                </label>
              ))}
            </div>
            <button className="primary-button full">
              <Plus size={18} />
              Cadastrar serviço
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function BarbersPage({ data }) {
  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading eyebrow="Equipe" title="Barbeiros disponíveis" />
        <div className="barber-grid">
          {data.barbers.map((barber) => (
            <article className="barber-card" key={barber.id}>
              <div className="avatar large">{initials(barber.name)}</div>
              <div>
                <strong>{barber.name}</strong>
                <p>{barber.bio}</p>
                <div className="tag-row">
                  {barber.specialties.map((specialty) => <span key={specialty}>{specialty}</span>)}
                </div>
              </div>
              <div className="rating">
                <Star size={17} fill="currentColor" />
                {barber.rating}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Comparativo" title="Performance por profissional" />
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.reports.barberPerformance}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="revenue" fill="#d5a84f" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}

function FinancePage({ data }) {
  const payments = data.payments;
  const commissionTotal = data.commissions.reduce((sum, commission) => sum + Number(commission.amount || 0), 0);
  const paidTotal = payments.filter((payment) => payment.status === 'paid').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

  return (
    <div className="page-grid">
      <div className="kpi-grid">
        <KpiCard icon={WalletCards} label="Pagamentos pagos" value={formatCurrency(paidTotal)} accent="gold" />
        <KpiCard icon={TimerReset} label="Pendentes" value={payments.filter((payment) => payment.status === 'pending').length} accent="red" />
        <KpiCard icon={Scissors} label="Comissões" value={formatCurrency(commissionTotal)} accent="blue" />
        <KpiCard icon={TrendingUp} label="Lucro estimado" value={formatCurrency(data.reports.kpis.estimatedProfit)} accent="green" />
      </div>

      <section className="panel wide">
        <SectionHeading eyebrow="Pagamentos" title="Controle financeiro" />
        <div className="table-list">
          {payments.map((payment) => {
            const appointment = data.appointments.find((item) => item.id === payment.appointmentId);
            const Icon = paymentIcon[payment.method] || WalletCards;
            return (
              <div className="table-row" key={payment.id}>
                <Icon size={18} />
                <span>{appointment?.client?.name || payment.clientId}</span>
                <strong>{formatCurrency(payment.amount)}</strong>
                <StatusPill status={payment.status} label={paymentLabel[payment.status] || payment.status} />
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Despesas" title="Contas e custos" />
        <div className="timeline-list">
          {data.expenses?.map((expense) => (
            <div className="compact-item" key={expense.id}>
              <strong>{expense.description}</strong>
              <span>{expense.category} · {expense.dueDate}</span>
              <b>{formatCurrency(expense.amount)}</b>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function InventoryPage({ data, token, refreshDashboard, setToast, user }) {
  const [productForm, setProductForm] = useState({ name: '', category: '', quantity: 0, purchasePrice: 0, salePrice: 0, minStock: 1 });
  const [movement, setMovement] = useState({ productId: data.products[0]?.id || '', type: 'purchase', quantity: 1, reason: '' });
  const canEdit = adminRoles.includes(user.role);

  async function createProduct(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/products', { method: 'POST', token, body: productForm });
      setToast({ type: 'success', message: 'Produto cadastrado.' });
      setProductForm({ name: '', category: '', quantity: 0, purchasePrice: 0, salePrice: 0, minStock: 1 });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  async function createMovement(event) {
    event.preventDefault();
    try {
      await apiRequest(`/api/products/${movement.productId}/movements`, { method: 'POST', token, body: movement });
      setToast({ type: 'success', message: 'Estoque atualizado.' });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading eyebrow="Produtos" title="Estoque e alertas" />
        <div className="product-grid">
          {data.products.map((product) => (
            <article className={`product-card ${product.quantity <= product.minStock ? 'low' : ''}`} key={product.id}>
              <Package size={22} />
              <div>
                <strong>{product.name}</strong>
                <span>{product.category} · SKU {product.sku}</span>
              </div>
              <b>{product.quantity}</b>
              <small>mín. {product.minStock}</small>
              <span>{formatCurrency(product.salePrice)}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Movimentação" title="Atualizar estoque" />
        <form className="stack-form" onSubmit={createMovement}>
          <Select
            label="Produto"
            value={movement.productId}
            onChange={(productId) => setMovement({ ...movement, productId })}
            options={data.products.map((product) => ({ label: product.name, value: product.id }))}
          />
          <Select
            label="Tipo"
            value={movement.type}
            onChange={(type) => setMovement({ ...movement, type })}
            options={[
              { label: 'Compra', value: 'purchase' },
              { label: 'Venda', value: 'sale' },
              { label: 'Uso interno', value: 'usage' },
              { label: 'Perda', value: 'loss' },
              { label: 'Ajuste', value: 'adjustment' }
            ]}
          />
          <Input label="Quantidade" type="number" value={movement.quantity} onChange={(quantity) => setMovement({ ...movement, quantity })} />
          <Input label="Motivo" value={movement.reason} onChange={(reason) => setMovement({ ...movement, reason })} />
          <button className="primary-button full">
            <Save size={18} />
            Registrar
          </button>
        </form>
      </section>

      {canEdit && (
        <section className="panel">
          <SectionHeading eyebrow="Cadastro" title="Novo produto" />
          <form className="stack-form" onSubmit={createProduct}>
            <Input label="Nome" value={productForm.name} onChange={(name) => setProductForm({ ...productForm, name })} />
            <Input label="Categoria" value={productForm.category} onChange={(category) => setProductForm({ ...productForm, category })} />
            <div className="input-row">
              <Input label="Qtd." type="number" value={productForm.quantity} onChange={(quantity) => setProductForm({ ...productForm, quantity })} />
              <Input label="Mín." type="number" value={productForm.minStock} onChange={(minStock) => setProductForm({ ...productForm, minStock })} />
            </div>
            <div className="input-row">
              <Input label="Compra" type="number" value={productForm.purchasePrice} onChange={(purchasePrice) => setProductForm({ ...productForm, purchasePrice })} />
              <Input label="Venda" type="number" value={productForm.salePrice} onChange={(salePrice) => setProductForm({ ...productForm, salePrice })} />
            </div>
            <button className="outline-button full">
              <Plus size={18} />
              Adicionar produto
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function ReportsPage({ data, token, setToast }) {
  const [exporting, setExporting] = useState(false);
  async function exportReport(format) {
    setExporting(true);
    try {
      await downloadWithAuth(
        `/api/reports/export?format=${format}`,
        token,
        format === 'pdf' ? 'barberpro-relatorio.pdf' : 'barberpro-relatorio.csv'
      );
      setToast({ type: 'success', message: 'Relatório gerado.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading
          eyebrow="Indicadores"
          title="Relatórios e gráficos"
          action={
            <div className="button-row">
              <button className="outline-button" disabled={exporting} onClick={() => exportReport('excel')}>
                <Download size={18} />
                Excel
              </button>
              <button className="primary-button" disabled={exporting} onClick={() => exportReport('pdf')}>
                <Download size={18} />
                PDF
              </button>
            </div>
          }
        />
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={290}>
            <BarChart data={data.reports.busyHours}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="hour" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="total" fill="#1f5f9f" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Serviços" title="Mais vendidos" />
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={data.reports.serviceRanking} dataKey="total" nameKey="name" innerRadius={54} outerRadius={86}>
              {data.reports.serviceRanking.map((entry, index) => (
                <Cell key={entry.name} fill={['#d5a84f', '#9e1b32', '#1f5f9f', '#5f6b73'][index % 4]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Clientes" title="Mais frequentes" />
        <div className="client-grid">
          {data.reports.frequentClients.map((client) => (
            <article className="client-card" key={client.id}>
              <div className="avatar">{initials(client.name)}</div>
              <div>
                <strong>{client.name}</strong>
                <span>{client.visits} visitas</span>
              </div>
              <b>{client.loyaltyPoints} pts</b>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReviewsPage({ data, setToast }) {
  const [reviewQrCode, setReviewQrCode] = useState('');
  const [selectedAppointmentId, setSelectedAppointmentId] = useState('');
  const reviewableAppointments = useMemo(
    () =>
      data.appointments
        .filter((appointment) => appointment.reviewToken && appointment.status === 'finished' && !appointment.review)
        .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`)),
    [data.appointments]
  );
  const selectedAppointment =
    reviewableAppointments.find((appointment) => appointment.id === selectedAppointmentId) ||
    reviewableAppointments[0] ||
    null;
  const reviewEvaluationUrl = selectedAppointment?.reviewToken
    ? buildReviewEvaluationUrl(selectedAppointment.reviewToken)
    : '';

  useEffect(() => {
    if (!reviewableAppointments.length) {
      setSelectedAppointmentId('');
      return;
    }
    if (!selectedAppointmentId || !reviewableAppointments.some((appointment) => appointment.id === selectedAppointmentId)) {
      setSelectedAppointmentId(reviewableAppointments[0].id);
    }
  }, [reviewableAppointments, selectedAppointmentId]);

  useEffect(() => {
    let active = true;

    if (!reviewEvaluationUrl) {
      setReviewQrCode('');
      return () => {
        active = false;
      };
    }

    QRCode.toDataURL(reviewEvaluationUrl, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#111111',
        light: '#ffffff'
      }
    })
      .then((dataUrl) => {
        if (active) setReviewQrCode(dataUrl);
      })
      .catch(() => {
        if (active) setReviewQrCode('');
      });

    return () => {
      active = false;
    };
  }, [reviewEvaluationUrl]);

  async function copyReviewUrl() {
    if (!reviewEvaluationUrl) return;
    try {
      await navigator.clipboard.writeText(reviewEvaluationUrl);
      setToast?.({ type: 'success', message: 'Link de avaliação copiado.' });
    } catch {
      setToast?.({ type: 'error', message: 'Não foi possível copiar o link.' });
    }
  }

  return (
    <div className="two-column">
      <section className="panel">
        <SectionHeading eyebrow="QR Code" title="Avaliação rápida" />
        {reviewableAppointments.length ? (
          <div className="stack-form">
            <Select
              label="Atendimento"
              value={selectedAppointment?.id || ''}
              onChange={setSelectedAppointmentId}
              options={reviewableAppointments.map((appointment) => ({
                label: `${appointment.code} · ${appointment.client?.name || 'Cliente'} · ${appointment.date} ${appointment.startTime}`,
                value: appointment.id
              }))}
            />
            <div className="qr-box">
              {reviewQrCode && <img src={reviewQrCode} alt="QR Code para avaliação" />}
              <QrCode size={28} />
            </div>
            <div className="qr-link">
              <span>{reviewEvaluationUrl}</span>
              <button className="outline-button" type="button" onClick={copyReviewUrl}>
                <Copy size={16} />
                Copiar
              </button>
            </div>
          </div>
        ) : (
          <EmptyState text="Nenhum atendimento finalizado pendente de avaliação." />
        )}
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Feedback" title="Avaliações dos clientes" />
        <div className="review-grid">
          {data.reviews.map((review) => (
            <ReviewCard review={review} data={data} key={review.id} />
          ))}
          {!data.reviews.length && <EmptyState text="Nenhuma avaliação registrada." />}
        </div>
      </section>
    </div>
  );
}

function PromotionsPage({ data, token, refreshDashboard, setToast, user }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    code: '',
    discountType: 'percent',
    discountValue: 10,
    startsAt: todayKey(),
    endsAt: todayKey(30),
    audience: 'all'
  });
  const canEdit = adminRoles.includes(user.role);

  async function createPromotion(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/promotions', { method: 'POST', token, body: form });
      setToast({ type: 'success', message: 'Promoção criada.' });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="two-column">
      <section className="panel wide">
        <SectionHeading eyebrow="Campanhas" title="Promoções e combos" />
        <div className="promo-grid">
          {data.promotions.map((promo) => (
            <article className="promo-card" key={promo.id}>
              <Megaphone size={22} />
              <div>
                <strong>{promo.title}</strong>
                <p>{promo.description}</p>
                <span>{promo.startsAt} até {promo.endsAt}</span>
              </div>
              <b>{promo.code}</b>
            </article>
          ))}
        </div>
      </section>

      {canEdit && (
        <section className="panel">
          <SectionHeading eyebrow="Automação" title="Nova promoção" />
          <form className="stack-form" onSubmit={createPromotion}>
            <Input label="Título" value={form.title} onChange={(title) => setForm({ ...form, title })} />
            <Textarea label="Descrição" value={form.description} onChange={(description) => setForm({ ...form, description })} />
            <Input label="Cupom" value={form.code} onChange={(code) => setForm({ ...form, code })} />
            <div className="input-row">
              <Input label="Valor" type="number" value={form.discountValue} onChange={(discountValue) => setForm({ ...form, discountValue })} />
              <Select
                label="Tipo"
                value={form.discountType}
                onChange={(discountType) => setForm({ ...form, discountType })}
                options={[
                  { label: '%', value: 'percent' },
                  { label: 'R$', value: 'fixed' }
                ]}
              />
            </div>
            <div className="input-row">
              <Input label="Início" type="date" value={form.startsAt} onChange={(startsAt) => setForm({ ...form, startsAt })} />
              <Input label="Fim" type="date" value={form.endsAt} onChange={(endsAt) => setForm({ ...form, endsAt })} />
            </div>
            <button className="primary-button full">
              <Send size={18} />
              Criar campanha
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function SettingsPage({ data, token, refreshDashboard, setToast }) {
  const [rules, setRules] = useState(data.settings.appointmentRules);
  const demoStatus = data.persistence?.demo;
  const showDemoReset = import.meta.env.DEV || demoStatus?.isDemo || demoStatus?.generatedForDate;

  async function saveSettings(event) {
    event.preventDefault();
    try {
      await apiRequest('/api/settings', { method: 'PATCH', token, body: { appointmentRules: rules } });
      setToast({ type: 'success', message: 'Configurações salvas.' });
      refreshDashboard();
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  async function backup() {
    try {
      await downloadWithAuth('/api/backup', token, `barberpro-backup-${todayKey()}.json`);
      setToast({ type: 'success', message: 'Backup baixado.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  async function resetDemo() {
    const confirmation = window.prompt(`Digite ${DEMO_RESET_CONFIRMATION} para restaurar a demonstracao local.`);
    if (confirmation !== DEMO_RESET_CONFIRMATION) return;

    try {
      await apiRequest('/api/demo/reset', {
        method: 'POST',
        token,
        body: { confirm: DEMO_RESET_CONFIRMATION }
      });
      await refreshDashboard();
      setToast({ type: 'success', message: 'Demonstracao restaurada.' });
    } catch (error) {
      setToast({ type: 'error', message: error.message });
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <SectionHeading eyebrow="Empresa" title={data.settings.barbershopName} />
        <div className="info-list">
          {data.units.map((unit) => (
            <div className="info-row" key={unit.id}>
              <Building2 size={18} />
              <span>{unit.name}</span>
              <small>{unit.address}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <SectionHeading eyebrow="Agenda" title="Regras de funcionamento" />
        <form className="stack-form" onSubmit={saveSettings}>
          <Input
            label="Intervalo de horários"
            type="number"
            value={rules.slotIntervalMinutes}
            onChange={(slotIntervalMinutes) => setRules({ ...rules, slotIntervalMinutes: Number(slotIntervalMinutes) })}
          />
          <Input
            label="Lembrete antes (min)"
            type="number"
            value={rules.reminderMinutesBefore}
            onChange={(reminderMinutesBefore) => setRules({ ...rules, reminderMinutesBefore: Number(reminderMinutesBefore) })}
          />
          <Input
            label="Limite para cancelar (h)"
            type="number"
            value={rules.cancellationLimitHours}
            onChange={(cancellationLimitHours) => setRules({ ...rules, cancellationLimitHours: Number(cancellationLimitHours) })}
          />
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={rules.allowClientReschedule}
              onChange={(event) => setRules({ ...rules, allowClientReschedule: event.target.checked })}
            />
            Cliente pode remarcar
          </label>
          <button className="primary-button full">
            <Save size={18} />
            Salvar regras
          </button>
        </form>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Segurança" title="Dados, sessões e auditoria" />
        <div className="security-grid">
          <AlertLine icon={LockKeyhole} label="Sessão" value={`${data.settings.security.sessionMinutes} min`} />
          <AlertLine icon={ShieldCheck} label="LGPD" value={data.settings.security.lgpdConsentRequired ? 'Consentimento ativo' : 'Opcional'} />
          <AlertLine icon={History} label="Logs" value={`${data.auditLogs.length} eventos`} />
          {demoStatus?.generatedForDate && (
            <AlertLine
              icon={TimerReset}
              label="Demo"
              value={demoStatus.stale ? `Gerada em ${demoStatus.generatedForDate}` : `Atual em ${demoStatus.generatedForDate}`}
            />
          )}
          <button className="outline-button" onClick={backup}>
            <Download size={18} />
            Backup do banco
          </button>
          {showDemoReset && (
            <button className="outline-button danger-action" type="button" onClick={resetDemo}>
              <TimerReset size={18} />
              Restaurar demo
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function SupportPage({ data }) {
  const whatsapp = data.settings.whatsappNumber;
  return (
    <div className="page-grid">
      <section className="panel wide">
        <SectionHeading eyebrow="Contato" title="Suporte e canais" />
        <div className="support-grid">
          <a className="support-card" href={`https://wa.me/${whatsapp}`} target="_blank" rel="noreferrer">
            <MessageCircle size={26} />
            <strong>WhatsApp</strong>
            <span>Atendimento, confirmações e promoções</span>
            <ChevronRight size={18} />
          </a>
          <a className="support-card" href="mailto:contato@barberpro.com">
            <Mail size={26} />
            <strong>E-mail</strong>
            <span>Notificações e recuperação de senha</span>
            <ChevronRight size={18} />
          </a>
          <div className="support-card">
            <Bell size={26} />
            <strong>Automações</strong>
            <span>Lembretes, aniversário, estoque baixo e clientes antigos</span>
            <ChevronRight size={18} />
          </div>
          <div className="support-card">
            <MapPin size={26} />
            <strong>Unidades</strong>
            <span>Múltiplas filiais com agenda e estoque por operação</span>
            <ChevronRight size={18} />
          </div>
        </div>
      </section>

      <section className="panel wide">
        <SectionHeading eyebrow="Notificações" title="Fila de mensagens" />
        <div className="table-list">
          {data.notifications.map((notification) => (
            <div className="table-row" key={notification.id}>
              <Bell size={18} />
              <span>{notification.title}</span>
              <strong>{notification.channel}</strong>
              <StatusPill status={notification.status} label={notification.status} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, accent = 'gold', flat = false }) {
  return (
    <article className={`kpi-card ${accent} ${flat ? 'flat' : ''}`}>
      <div className="kpi-icon">
        <Icon size={22} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AppointmentCard({ appointment, canManage, onStatus, onCancel }) {
  return (
    <article className={`appointment-card ${appointment.status}`}>
      <div className="appointment-time">
        <strong>{appointment.startTime}</strong>
        <span>{appointment.endTime}</span>
      </div>
      <div className="appointment-main">
        <StatusPill status={appointment.status} label={statusLabel[appointment.status]} />
        <h3>{appointment.client?.name}</h3>
        <p>{appointment.service?.name} · {appointment.barber?.name}</p>
        <small>{appointment.date} · {formatCurrency(appointment.service?.price)}</small>
      </div>
      {canManage && (
        <div className="appointment-actions">
          {appointment.status === 'scheduled' && (
            <button title="Confirmar" onClick={() => onStatus(appointment.id, 'confirmed')}>
              <Check size={16} />
            </button>
          )}
          {['scheduled', 'confirmed'].includes(appointment.status) && (
            <button title="Iniciar" onClick={() => onStatus(appointment.id, 'in_service')}>
              <Clock3 size={16} />
            </button>
          )}
          {appointment.status === 'in_service' && (
            <button title="Finalizar" onClick={() => onStatus(appointment.id, 'finished')}>
              <BadgeCheck size={16} />
            </button>
          )}
          {['scheduled', 'confirmed'].includes(appointment.status) && (
            <button title="Não compareceu" onClick={() => onStatus(appointment.id, 'no_show')}>
              <UserCog size={16} />
            </button>
          )}
          {!['finished', 'cancelled'].includes(appointment.status) && (
            <button title="Cancelar" onClick={() => onCancel(appointment.id)}>
              <X size={16} />
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function AppointmentRow({ appointment, compact = false }) {
  return (
    <div className="appointment-row">
      <div className="time-dot">
        <Clock3 size={15} />
      </div>
      <div>
        <strong>{appointment.startTime} · {appointment.client?.name}</strong>
        <span>{appointment.service?.name} com {appointment.barber?.name}</span>
        {!compact && <small>{appointment.date} · {appointment.notes || 'Sem observações'}</small>}
      </div>
      <StatusPill status={appointment.status} label={statusLabel[appointment.status]} />
    </div>
  );
}

function ReviewCard({ review, data }) {
  const client = data.clients.find((item) => item.id === review.clientId);
  const barber = data.barbers.find((item) => item.id === review.barberId);
  return (
    <article className="review-card">
      <div className="stars">
        {Array.from({ length: 5 }, (_, index) => (
          <Star key={index} size={16} fill={index < review.rating ? 'currentColor' : 'none'} />
        ))}
      </div>
      <p>{review.comment || 'Sem comentário.'}</p>
      <strong>{client?.name}</strong>
      <span>{barber?.name} · {String(review.createdAt).slice(0, 10)}</span>
    </article>
  );
}

function RoleBadge({ role }) {
  return (
    <div className="role-badge">
      <ShieldCheck size={16} />
      {roleLabel[role] || role}
    </div>
  );
}

function StatusPill({ status, label }) {
  return <span className={`status-pill ${status}`}>{label}</span>;
}

function SectionHeading({ eyebrow, title, action }) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function Input({ label, value, onChange, type = 'text', icon: Icon }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-shell">
        {Icon && <Icon size={16} />}
        <input type={type} value={value ?? ''} onChange={(event) => onChange(event.target.value)} />
      </div>
    </label>
  );
}

function Textarea({ label, value, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value ?? ''} onChange={(event) => onChange(event.target.value)} rows={4} />
    </label>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={`${option.value}-${option.label}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyState({ text }) {
  return (
    <div className="empty-state">
      <ClipboardList size={24} />
      <span>{text}</span>
    </div>
  );
}

function AlertLine({ icon: Icon, label, value }) {
  return (
    <div className="alert-line">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetricMini({ label, value }) {
  return (
    <div className="metric-mini">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ChartLegend() {
  return (
    <div className="chart-legend">
      <span><i className="gold-dot" /> Receita</span>
      <span><i className="blue-dot" /> Atendimentos</span>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.map((item) => (
        <span key={item.dataKey}>
          {item.name || item.dataKey}: {typeof item.value === 'number' && item.dataKey === 'revenue' ? formatCurrency(item.value) : item.value}
        </span>
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <div className="spinner" />
      <span>Carregando BarberPro</span>
    </div>
  );
}

function PersistenceBanner({ status, onRetry, publicView = false }) {
  if (!status || status.writable) return null;
  const title = status.mode === 'mysql' ? 'MySQL/XAMPP indisponivel' : 'Persistencia local indisponivel';
  return (
    <div className={`persistence-banner ${publicView ? 'public' : ''}`}>
      <AlertTriangle size={20} />
      <div>
        <strong>{title}</strong>
        <span>{status.message || 'Escritas bloqueadas para proteger os dados locais.'}</span>
      </div>
      <button className="outline-button" onClick={onRetry}>
        <RotateCw size={16} />
        Verificar
      </button>
    </div>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.type}`}>
      <span>{toast.message}</span>
      <button onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

export default App;
