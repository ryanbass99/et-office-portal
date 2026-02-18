"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type SalesData = {
  name: string;
  total: number;
};

export default function TopSalesmanChart({ data }: { data: SalesData[] }) {
  return (
    <div style={{ width: "100%", height: 350 }}>
      <ResponsiveContainer>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
        >
          <CartesianGrid strokeDasharray="3 3" />

          <XAxis
            type="number"
            tickFormatter={(value) =>
              new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              }).format(Number(value ?? 0))
            }
          />

          <YAxis
            type="category"
            dataKey="name"
            width={120}
            tick={{ fontSize: 12 }}
          />

          <Tooltip
            cursor={false}
            contentStyle={{
              backgroundColor: "#ffffff",
              border: "1px solid #000000",
            }}
            itemStyle={{ color: "#000000" }}
            labelStyle={{ color: "#000000" }}
            formatter={(value) => {
              if (value == null) return "";
              return new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              }).format(Number(value));
            }}
          />

          <Bar
            dataKey="total"
            fill="#dc2626"
            barSize={22}
            radius={[0, 3, 3, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
