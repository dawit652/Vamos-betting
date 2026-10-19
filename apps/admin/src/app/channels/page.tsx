'use client';

import type { ChannelFlagsResponse } from '@vamos/contracts';
import { useFetch } from '@/components/hooks';
import { Badge, Loading, PageHeader } from '@/components/ui';
import { flagRows } from '@/lib/channels';

/** Read-only: the switches live in the server environment and change only by a deployment. */
export default function ChannelsPage() {
  const { data, error, loading } = useFetch<ChannelFlagsResponse>('/admin/channels');
  return (
    <>
      <PageHeader title="Channels" />
      <p className="muted">
        SMS and USSD betting stay off until the regulator approves the channel. The switches are set
        in the server environment (not here); changing one is a deployment.
      </p>
      <Loading loading={loading} error={error} />
      {data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Status</th>
                <th>Variable</th>
                <th>Aggregator</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {flagRows(data).map((row) => (
                <tr key={row.key}>
                  <td>{row.name}</td>
                  <td>
                    <Badge
                      value={row.enabled ? 'enabled' : 'disabled'}
                      tone={row.enabled ? 'good' : 'muted'}
                    />
                  </td>
                  <td>
                    <code>{row.variable}</code>
                  </td>
                  <td>{row.aggregator}</td>
                  <td>{row.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
